// app/api/warehouses/route.ts
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { auth } from '@clerk/nextjs/server';
import { ensureOrganizationMember } from '@/lib/auth';
import { unstable_cache } from 'next/cache';


export const revalidate = 3000; 

export type Warehouse = {
  id: string;
  name: string;
  address: string;
  createdAt: string;
  updatedAt: string;
  productCount: number;
  totalStock: number;
  isDefault?: boolean;
};

// ============================================
// CACHED WAREHOUSE FETCHER
// ============================================

const getCachedWarehouses = unstable_cache(
  async (orgId: string) => {
    const bigOrgId = BigInt(orgId);

    const warehouses = await prisma.warehouse.findMany({
      where: { org_id: bigOrgId },
      include: {
        productStocks: {
          select: {
            quantity: true,
            product: {
              select: {
                product_id: true,
                name: true,
              }
            }
          }
        },
        _count: {
          select: { productStocks: true }
        }
      },
      orderBy: { created_at: 'asc' },
    });

    const formattedWarehouses: Warehouse[] = warehouses.map((warehouse, index) => {
      const totalStock = warehouse.productStocks.reduce(
        (sum, stock) => sum + (stock.quantity || 0),
        0
      );

      return {
        id: warehouse.warehouse_id.toString(),
        name: warehouse.name || 'Unnamed Warehouse',
        address: warehouse.address || 'No address',
        createdAt: warehouse.created_at?.toISOString() || new Date().toISOString(),
        updatedAt: warehouse.updated_at?.toISOString() || new Date().toISOString(),
        productCount: warehouse._count.productStocks,
        totalStock,
        isDefault: index === 0,
      };
    });

    return formattedWarehouses;
  },
  ['warehouses'],
  { 
    revalidate: 300, // 5 minutes
    tags: ['warehouses', 'warehouse-list'] 
  }
);

// ============================================
// API ROUTE
// ============================================

export async function GET(request: NextRequest) {
  try {
    const { userId } = auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get('orgId');

    if (!orgId) {
      return NextResponse.json({ error: 'Organization ID required' }, { status: 400 });
    }

    await ensureOrganizationMember(orgId);

    // ✅ Use cached version
    const warehouses = await getCachedWarehouses(orgId);

    return NextResponse.json(warehouses, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (error) {
    console.error('Error fetching warehouses:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch warehouses' },
      { status: 500 }
    );
  }
}
