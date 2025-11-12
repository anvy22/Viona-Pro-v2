// app/organization/actions.ts
'use server';

import prisma from '@/lib/prisma';
import { auth } from '@clerk/nextjs/server';
import { currentUser } from '@clerk/nextjs/server';
import crypto from 'crypto';
import { 
  getUserRole, 
  hasPermission, 
  ensureOrganizationMember,
  invalidateUserCache,
  invalidateOrgMemberCache 
} from '@/lib/auth';
import { revalidatePath, revalidateTag, unstable_cache } from 'next/cache';

type SimpleOrg = {
  id: string;
  name: string;
  role: string;
};

// ============================================
// CACHE TAGS
// ============================================

const CACHE_TAGS = {
  ORGANIZATIONS: 'organizations',
  USER_ORGS: 'user-organizations',
} as const;

// ============================================
// HELPER FUNCTIONS
// ============================================

async function getOrCreateUser(userId: string) {
  let user = await prisma.user.findUnique({ 
    where: { clerk_id: userId },
    select: { user_id: true, email: true, clerk_id: true }
  });
  
  if (!user) {
    const clerkUser = await currentUser();
    if (!clerkUser?.emailAddresses[0]?.emailAddress) {
      throw new Error('Unable to get user email from Clerk');
    }
    
    user = await prisma.user.create({
      data: { 
        clerk_id: userId, 
        email: clerkUser.emailAddresses[0].emailAddress
      },
      select: { user_id: true, email: true, clerk_id: true }
    });
    
    await invalidateUserCache();
  }
  
  return user;
}

// Helper to invalidate organization caches
async function invalidateOrganizationCaches() {
  revalidateTag(CACHE_TAGS.ORGANIZATIONS);
  revalidateTag(CACHE_TAGS.USER_ORGS);
  await invalidateOrgMemberCache();
}

// ============================================
// CACHED ORGANIZATION QUERIES
// ============================================

// Cache user organizations for 10 minutes
const getCachedUserOrganizations = unstable_cache(
  async (userId: string) => {
    const user = await prisma.user.findUnique({
      where: { clerk_id: userId },
      select: {
        user_id: true,
        createdOrganizations: {
          select: { org_id: true, name: true, created_at: true }
        },
        organizationMembers: {
          select: { 
            role: true,
            org: { 
              select: { org_id: true, name: true, created_at: true }
            }
          },
        },
      },
    });

    if (!user) return null;

    const orgs: SimpleOrg[] = [
      ...user.createdOrganizations.map((o) => ({
        id: o.org_id.toString(),
        name: o.name,
        role: 'admin',
      })),
      ...user.organizationMembers.map((m) => ({
        id: m.org.org_id.toString(),
        name: m.org.name,
        role: m.role,
      })),
    ];

    // Remove duplicates by id
    const uniqueOrgs = orgs.filter(
      (org, index, self) => index === self.findIndex((o) => o.id === org.id)
    );

    return uniqueOrgs;
  },
  ['user-organizations'],
  { 
    revalidate: 600, // 10 minutes
    tags: [CACHE_TAGS.USER_ORGS, CACHE_TAGS.ORGANIZATIONS] 
  }
);

export async function getUserOrganizations(): Promise<SimpleOrg[]> {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  const orgs = await getCachedUserOrganizations(userId);
  if (!orgs) throw new Error('User not found');

  return orgs;
}

// ============================================
// ORGANIZATION MUTATIONS
// ============================================

export async function createOrganization(name: string) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');
  if (!name?.trim()) throw new Error('Organization name is required');

  const trimmedName = name.trim();
  const user = await getOrCreateUser(userId);

  // Case-insensitive duplicate check
  const existingOrg = await prisma.organization.findFirst({
    where: {
      created_by: user.user_id,
      name: {
        equals: trimmedName,
        mode: 'insensitive',
      },
    },
    select: { org_id: true }
  });

  if (existingOrg) {
    throw new Error('You already have an organization with this name');
  }

  // Use transaction for atomic operations
  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: trimmedName, created_by: user.user_id },
      select: { org_id: true, name: true }
    });

    await tx.organizationMember.create({
      data: { 
        org_id: org.org_id, 
        user_id: user.user_id, 
        role: 'admin' 
      },
    });

    // Verify member creation
    const verifyMember = await tx.organizationMember.findUnique({
      where: {
        org_id_user_id: {
          org_id: org.org_id,
          user_id: user.user_id,
        }
      },
      select: { role: true }
    });

    if (!verifyMember || verifyMember.role !== 'admin') {
      throw new Error('Failed to create organization member record');
    }

    return {
      orgId: org.org_id.toString(),
      name: org.name
    };
  });

  // ✅ Invalidate all organization caches
  await invalidateOrganizationCaches();
  revalidatePath('/organization');
  revalidatePath('/dashboard');
  
  return result.orgId;
}

export async function updateOrganization(orgId: string, name: string) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');
  if (!orgId) throw new Error('Organization ID is required');
  if (!name?.trim()) throw new Error('Organization name is required');

  try {
    const bigOrgId = BigInt(orgId);
    
    await ensureOrganizationMember(orgId);
    
    const role = await getUserRole(orgId);
    if (!(await hasPermission(role, ['admin']))) {
      throw new Error('Only admins can update organizations');
    }

    await prisma.organization.update({
      where: { org_id: bigOrgId },
      data: { name: name.trim() },
    });

    // ✅ Invalidate organization caches (name changed)
    await invalidateOrganizationCaches();
    revalidatePath('/organization');
    revalidatePath('/dashboard');
    
    return { success: true };

  } catch (error) {
    console.error('Error updating organization:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Cannot convert') && error.message.includes('BigInt')) {
        throw new Error('Invalid organization ID format');
      }
      throw error;
    }
    
    throw new Error('Failed to update organization. Please try again.');
  }
}

export async function deleteOrganization(orgId: string, force: boolean = false) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');
  if (!orgId) throw new Error('Organization ID is required');

  try {
    const bigOrgId = BigInt(orgId);
    
    await ensureOrganizationMember(orgId);
    
    const role = await getUserRole(orgId);
    if (!(await hasPermission(role, ['admin']))) {
      throw new Error('Only admins can delete organizations');
    }

    // Check for related data
    const [warehouses, products, orders] = await Promise.all([
      prisma.warehouse.count({ where: { org_id: bigOrgId } }),
      prisma.product.count({ where: { org_id: bigOrgId } }),
      prisma.order.count({ where: { org_id: bigOrgId } }),
    ]);

    if ((warehouses > 0 || products > 0 || orders > 0) && !force) {
      const dataDetails = [];
      if (warehouses > 0) dataDetails.push(`${warehouses} warehouse${warehouses === 1 ? '' : 's'}`);
      if (products > 0) dataDetails.push(`${products} product${products === 1 ? '' : 's'}`);
      if (orders > 0) dataDetails.push(`${orders} order${orders === 1 ? '' : 's'}`);
      
      throw new Error(
        `Cannot delete organization. It contains: ${dataDetails.join(', ')}. ` +
        `To delete this organization and all its data permanently, use the force delete option. ` +
        `This action cannot be undone.`
      );
    }

    // Use transaction for atomic deletion
    await prisma.$transaction(async (tx) => {
      if (force && (warehouses > 0 || products > 0 || orders > 0)) {
        // Delete in correct order for foreign key constraints
        await tx.orderItem.deleteMany({
          where: { order: { org_id: bigOrgId } }
        });

        await tx.order.deleteMany({ 
          where: { org_id: bigOrgId } 
        });

        await tx.productPrice.deleteMany({
          where: { product: { org_id: bigOrgId } }
        });

        await tx.productStock.deleteMany({
          where: { product: { org_id: bigOrgId } }
        });

        await tx.product.deleteMany({ 
          where: { org_id: bigOrgId } 
        });

        await tx.warehouse.deleteMany({ 
          where: { org_id: bigOrgId } 
        });
      }

      await tx.organizationInvite.deleteMany({ 
        where: { org_id: bigOrgId } 
      });

      await tx.organizationMember.deleteMany({ 
        where: { org_id: bigOrgId } 
      });

      await tx.organization.delete({ 
        where: { org_id: bigOrgId }
      });
    });

    // ✅ Invalidate all organization caches
    await invalidateOrganizationCaches();
    revalidatePath('/organization');
    revalidatePath('/dashboard');
    revalidatePath('/inventory');

    return { 
      success: true,
      message: force 
        ? 'Organization and all its data have been permanently deleted'
        : 'Organization deleted successfully'
    };

  } catch (error) {
    console.error('Error deleting organization:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Cannot convert') && error.message.includes('BigInt')) {
        throw new Error('Invalid organization ID format');
      }
      
      if (error.message.includes('Foreign key constraint')) {
        throw new Error('Cannot delete organization due to data dependencies. Please use force delete.');
      }
      
      throw error;
    }
    
    throw new Error('Failed to delete organization. Please try again.');
  }
}

// ============================================
// MEMBER INVITATIONS
// ============================================

export async function inviteEmployee(orgId: string, email: string, role: string) {
  if (!orgId) throw new Error('Organization ID is required');
  if (!email?.trim()) throw new Error('Email is required');
  if (!role?.trim()) throw new Error('Role is required');

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const bigOrgId = BigInt(orgId);
    
    await ensureOrganizationMember(orgId);
    
    const currentRole = await getUserRole(orgId);
    if (!(await hasPermission(currentRole, ['admin']))) {
      throw new Error('Only admins can invite employees');
    }

    // Check for existing member or pending invite
    const [existingMember, pendingInvite] = await Promise.all([
      prisma.organizationMember.findFirst({
        where: {
          org_id: bigOrgId,
          user: { email: normalizedEmail }
        },
        select: { user_id: true }
      }),
      prisma.organizationInvite.findFirst({
        where: {
          org_id: bigOrgId,
          email: normalizedEmail,
          status: 'pending',
          expires_at: { gte: new Date() }
        },
        select: { token: true }
      })
    ]);

    if (existingMember) {
      throw new Error('User is already a member of this organization');
    }

    if (pendingInvite) {
      throw new Error('A pending invitation already exists for this email');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.organizationInvite.create({
      data: {
        org_id: bigOrgId,
        email: normalizedEmail,
        token,
        role: role.trim(),
        expires_at: expiresAt,
      },
    });

    // Note: Invitations don't affect org list, no cache invalidation needed
    revalidatePath('/organization');
    
    return token;

  } catch (error) {
    console.error('Error inviting employee:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Cannot convert') && error.message.includes('BigInt')) {
        throw new Error('Invalid organization ID format');
      }
      throw error;
    }
    
    throw new Error('Failed to invite employee. Please try again.');
  }
}

export async function acceptInvite(token: string) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');
  if (!token?.trim()) throw new Error('Invalid invitation token');

  try {
    const invite = await prisma.organizationInvite.findUnique({
      where: { token: token.trim() },
      select: {
        org_id: true,
        email: true,
        role: true,
        status: true,
        expires_at: true
      }
    });

    if (!invite || invite.status !== 'pending') {
      throw new Error('Invalid invitation');
    }

    if (!invite.expires_at || new Date(invite.expires_at) < new Date()) {
      throw new Error('Invitation has expired');
    }

    const user = await getOrCreateUser(userId);

    if (invite.email !== user.email) {
      throw new Error('Email mismatch - invitation not for this user');
    }

    // Check if already a member
    const existingMember = await prisma.organizationMember.findUnique({
      where: {
        org_id_user_id: {
          org_id: invite.org_id,
          user_id: user.user_id,
        },
      },
      select: { user_id: true }
    });

    if (existingMember) {
      throw new Error('User is already a member of this organization');
    }

    // Use transaction for atomic operations
    const orgId = await prisma.$transaction(async (tx) => {
      await tx.organizationMember.create({
        data: { 
          org_id: invite.org_id, 
          user_id: user.user_id, 
          role: invite.role 
        },
      });

      await tx.organizationInvite.update({
        where: { token: token.trim() },
        data: { status: 'accepted' },
      });

      return invite.org_id.toString();
    });

    // ✅ Invalidate caches - user now has access to new org
    await invalidateOrganizationCaches();
    revalidatePath('/organization');
    revalidatePath('/dashboard');
    
    return orgId;

  } catch (error) {
    console.error('Error accepting invite:', error);
    
    if (error instanceof Error) {
      throw error;
    }
    
    throw new Error('Failed to accept invitation. Please try again.');
  }
}

// ============================================
// MEMBER MANAGEMENT
// ============================================

export async function removeMember(orgId: string, memberUserId: string) {
  const { userId: currentUserId } = auth();
  if (!currentUserId) throw new Error('Unauthorized');

  await ensureOrganizationMember(orgId);
  
  const role = await getUserRole(orgId);
  if (!(await hasPermission(role, ['admin']))) {
    throw new Error('Only admins can remove members');
  }

  await prisma.organizationMember.delete({
    where: {
      org_id_user_id: {
        org_id: BigInt(orgId),
        user_id: BigInt(memberUserId)
      }
    }
  });

  // ✅ Invalidate caches - membership changed
  await invalidateOrganizationCaches();
  revalidatePath('/organization');
  
  return { success: true };
}

export async function updateMemberRole(orgId: string, memberUserId: string, newRole: string) {
  const { userId: currentUserId } = auth();
  if (!currentUserId) throw new Error('Unauthorized');

  await ensureOrganizationMember(orgId);
  
  const role = await getUserRole(orgId);
  if (!(await hasPermission(role, ['admin']))) {
    throw new Error('Only admins can update member roles');
  }

  await prisma.organizationMember.update({
    where: {
      org_id_user_id: {
        org_id: BigInt(orgId),
        user_id: BigInt(memberUserId)
      }
    },
    data: { role: newRole }
  });

  // ✅ Invalidate auth cache - role changed
  await invalidateOrgMemberCache();
  revalidatePath('/organization');
  
  return { success: true };
}
