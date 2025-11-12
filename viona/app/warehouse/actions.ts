'use server';

import prisma from '@/lib/prisma';
import { auth } from '@clerk/nextjs/server';
import { getUserRole, hasPermission, ensureOrganizationMember } from '@/lib/auth';
import { revalidatePath, revalidateTag  } from 'next/cache';


function invalidateWarehouseCaches() {
    revalidateTag('warehouses');
    revalidateTag('warehouse-list');
  }

export async function createWarehouse(orgId: string, data: { name: string; address: string }) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  if (!data.name?.trim()) throw new Error('Warehouse name is required');
  if (!data.address?.trim()) throw new Error('Warehouse address is required');

  try {
    await ensureOrganizationMember(orgId);
    
    const role = await getUserRole(orgId);
    if (!hasPermission(role, ['writer', 'read-write', 'admin'])) {
      throw new Error('Insufficient permissions to create warehouse');
    }

    const bigOrgId = BigInt(orgId);

    const warehouse = await prisma.warehouse.create({
      data: {
        org_id: bigOrgId,
        name: data.name.trim(),
        address: data.address.trim(),
      },
      select: {
        warehouse_id: true,
        name: true,
        address: true,
        created_at: true,
      }
    });

    invalidateWarehouseCaches();

    revalidatePath('/warehouse');
    revalidatePath(`/warehouse/${orgId}`);
    revalidatePath('/dashboard');

    return {
      success: true,
      warehouseId: warehouse.warehouse_id.toString(),
      data: {
        id: warehouse.warehouse_id.toString(),
        name: warehouse.name,
        address: warehouse.address,
        createdAt: warehouse.created_at?.toISOString(),
      },
      message: `Warehouse "${warehouse.name}" has been successfully created`,
    };
  } catch (error) {
    console.error('Error creating warehouse:', error);
    throw error instanceof Error ? error : new Error('Failed to create warehouse');
  }
}

export async function updateWarehouse(
  orgId: string,
  warehouseId: string,
  data: { name: string; address: string }
) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  if (!data.name?.trim()) throw new Error('Warehouse name is required');
  if (!data.address?.trim()) throw new Error('Warehouse address is required');

  try {
    await ensureOrganizationMember(orgId);
    
    const role = await getUserRole(orgId);
    if (!hasPermission(role, ['writer', 'read-write', 'admin'])) {
      throw new Error('Insufficient permissions to update warehouse');
    }

    const bigOrgId = BigInt(orgId);
    const bigWarehouseId = BigInt(warehouseId);

    // Verify warehouse belongs to organization
    const existingWarehouse = await prisma.warehouse.findFirst({
      where: {
        warehouse_id: bigWarehouseId,
        org_id: bigOrgId,
      },
      select: { warehouse_id: true, name: true }
    });

    if (!existingWarehouse) {
      throw new Error('Warehouse not found in this organization');
    }

    const warehouse = await prisma.warehouse.update({
      where: { warehouse_id: bigWarehouseId },
      data: {
        name: data.name.trim(),
        address: data.address.trim(),
      },
      select: {
        warehouse_id: true,
        name: true,
        address: true,
        updated_at: true,
      }
    });

    invalidateWarehouseCaches();
    revalidatePath('/warehouse');
    revalidatePath(`/warehouse/${orgId}`);
    revalidatePath(`/warehouse/${warehouseId}`);
    revalidatePath('/dashboard');

    return {
      success: true,
      warehouseId: warehouse.warehouse_id.toString(),
      data: {
        id: warehouse.warehouse_id.toString(),
        name: warehouse.name,
        address: warehouse.address,
        updatedAt: warehouse.updated_at?.toISOString(),
      },
      message: `Warehouse "${warehouse.name}" has been successfully updated`,
    };
  } catch (error) {
    console.error('Error updating warehouse:', error);
    throw error instanceof Error ? error : new Error('Failed to update warehouse');
  }
}

export async function deleteWarehouse(orgId: string, warehouseId: string) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  try {
    await ensureOrganizationMember(orgId);
    
    const role = await getUserRole(orgId);
    if (!hasPermission(role, ['admin'])) {
      throw new Error('Only admins can delete warehouses');
    }

    const bigOrgId = BigInt(orgId);
    const bigWarehouseId = BigInt(warehouseId);

    // Check if it's the default/first warehouse
    const warehouses = await prisma.warehouse.findMany({
      where: { org_id: bigOrgId },
      orderBy: { created_at: 'asc' },
      select: { warehouse_id: true }
    });

    if (warehouses.length === 1) {
      throw new Error('Cannot delete the last warehouse. Organizations must have at least one warehouse.');
    }

    if (warehouses[0].warehouse_id === bigWarehouseId) {
      throw new Error('Cannot delete the default warehouse. Please set another warehouse as default first.');
    }

    // Check for existing stock
    const stockCount = await prisma.productStock.count({
      where: { warehouse_id: bigWarehouseId }
    });

    if (stockCount > 0) {
      throw new Error('Cannot delete warehouse with existing stock. Please move or remove all stock first.');
    }

    await prisma.warehouse.delete({
      where: { warehouse_id: bigWarehouseId }
    });

    invalidateWarehouseCaches();

    revalidatePath('/warehouse');
    revalidatePath(`/warehouse/${orgId}`);
    revalidatePath('/dashboard');

    return {
      success: true,
      warehouseId,
      message: 'Warehouse has been successfully deleted',
    };
  } catch (error) {
    console.error('Error deleting warehouse:', error);
    throw error instanceof Error ? error : new Error('Failed to delete warehouse');
  }
}

export async function ensureDefaultWarehouse(orgId: string) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  try {
    await ensureOrganizationMember(orgId);
    const bigOrgId = BigInt(orgId);

    const existingWarehouse = await prisma.warehouse.findFirst({
      where: { org_id: bigOrgId },
      select: { warehouse_id: true }
    });

    if (!existingWarehouse) {
      const warehouse = await prisma.warehouse.create({
        data: {
          org_id: bigOrgId,
          name: 'Default Warehouse',
          address: 'Default Address',
        },
        select: { warehouse_id: true, name: true }
      });

      revalidatePath('/warehouse');
      revalidatePath(`/warehouse/${orgId}`);

      return {
        success: true,
        warehouseId: warehouse.warehouse_id.toString(),
        message: 'Default warehouse created',
      };
    }

    return {
      success: true,
      warehouseId: existingWarehouse.warehouse_id.toString(),
      message: 'Default warehouse already exists',
    };
  } catch (error) {
    console.error('Error ensuring default warehouse:', error);
    throw error instanceof Error ? error : new Error('Failed to ensure default warehouse');
  }
}
