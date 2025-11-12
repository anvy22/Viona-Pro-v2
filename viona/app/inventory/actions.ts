//app/inventory/actions.ts:
'use server';

import prisma from '@/lib/prisma';
import { auth } from '@clerk/nextjs/server';
import { currentUser } from '@clerk/nextjs/server';
import { getUserRole, hasPermission, ensureOrganizationMember } from '@/lib/auth'; 
import type { Product } from "../api/inventory/products/route";
import { revalidatePath, unstable_cache, revalidateTag } from 'next/cache';
import { CacheService } from '@/lib/cache';



const TAGS = {
  PRODUCT: "product", 
  WAREHOUSE: "warehouse",
  ORDERS: "orders",
} as const;

const REVAL = {
  SHORT: 60,
  MEDIUM: 300,
  LONG: 900,
} as const;

const CACHE_TAGS = {
  PRODUCTS: 'products',
  PRODUCT: (id: string) => `product-${id}`,
  ORG_PRODUCTS: (orgId: string) => `org-products-${orgId}`,
} as const;

// Revalidation times (in seconds)
const REVALIDATE = {
  SHORT: 60,
  MEDIUM: 300,
  LONG: 900,
} as const;


// Helper to verify permissions
async function verifyPermissions(orgId: string, requiredPerms: string[]) {
  const { userId } = await getAuthenticatedUser();
  await ensureOrganizationMember(orgId);
  
  const role = await getUserRole(orgId);
  if (!hasPermission(role, requiredPerms)) {
    throw new Error("Insufficient permissions");
  }
  
  return { userId };

}

async function getAuthenticatedUser() {
  const { userId } = auth();
  if (!userId) throw new Error("Unauthorized");
  return { userId };
}


async function getUserWithPermissions(orgId: string, requiredPermissions: string[]) {
  const { userId } = await getAuthenticatedUser();
  
  await ensureOrganizationMember(orgId);
  const role = await getUserRole(orgId);
  if (!hasPermission(role, requiredPermissions)) {
    throw new Error("Insufficient permissions");
  }
  
  return { userId };
}


const getCachedProductDetails = unstable_cache(
  async (orgId: string, productId: string) => {
    const bigOrgId = BigInt(orgId);
    const bigPid = BigInt(productId);

    const product = await prisma.product.findFirst({
      where: { product_id: bigPid, org_id: bigOrgId },
      select: {
        product_id: true,
        name: true,
        sku: true,
        description: true,
        image_url: true,
        status: true,
        created_at: true,
        updated_at: true,
        createdBy: { select: { user_id: true, email: true } },
        modifiedBy: { select: { user_id: true, email: true } },
        productStocks: {
          where: { quantity: { gt: 0 } },
          select: {
            quantity: true,
            warehouse: { select: { warehouse_id: true, name: true, address: true } },
          },
        },
        productPrices: {
          orderBy: { valid_from: "desc" },
          take: 10,
          select: {
            price_id: true,
            retail_price: true,
            actual_price: true,
            market_price: true,
            valid_from: true,
            valid_to: true,
          },
        },
      },
    });

    if (!product) throw new Error("Product not found");

    // Separate query for orders to avoid complex joins
    const recentOrders = await prisma.orderItem.findMany({
      where: { product_id: bigPid, order: { org_id: bigOrgId } },
      select: {
        quantity: true,
        price_at_order: true,
        order: {
          select: {
            order_id: true,
            order_date: true,
            customer_name: true,
            status: true,
          },
        },
      },
      orderBy: { order: { order_date: "desc" } },
      take: 5,
    });

    const totalStock = product.productStocks.reduce((a, s) => a + (s.quantity || 0), 0);
    const currentPrice = Number(product.productPrices[0]?.retail_price || 0);

    return {
      id: product.product_id.toString(),
      name: product.name || "",
      sku: product.sku || "",
      description: product.description || "",
      image: product.image_url || "",
      status: product.status || "active",
      createdAt: product.created_at?.toISOString() || new Date().toISOString(),
      updatedAt: product.updated_at?.toISOString() || new Date().toISOString(),
      createdBy: {
        id: product.createdBy?.user_id.toString() || "",
        email: product.createdBy?.email || "Unknown",
      },
      modifiedBy: product.modifiedBy
        ? {
            id: product.modifiedBy.user_id.toString(),
            email: product.modifiedBy.email,
          }
        : null,
      warehouses: product.productStocks.map((ps) => ({
        id: ps.warehouse.warehouse_id.toString(),
        name: ps.warehouse.name,
        address: ps.warehouse.address || "",
        stock: ps.quantity || 0,
      })),
      priceHistory: product.productPrices.map((pp) => ({
        id: pp.price_id.toString(),
        retailPrice: Number(pp.retail_price || 0),
        actualPrice: pp.actual_price ? Number(pp.actual_price) : undefined,
        marketPrice: pp.market_price ? Number(pp.market_price) : undefined,
        validFrom: pp.valid_from?.toISOString() || new Date().toISOString(),
        validTo: pp.valid_to?.toISOString() || undefined,
      })),
      recentOrders: recentOrders.map((oi) => ({
        orderId: oi.order.order_id.toString(),
        orderDate: oi.order.order_date?.toISOString() || new Date().toISOString(),
        customerName: oi.order.customer_name || "Unknown Customer",
        quantity: oi.quantity || 0,
        priceAtOrder: Number(oi.price_at_order || 0),
        status: oi.order.status || "pending",
      })),
      totalStock,
      currentPrice,
      currentActualPrice: product.productPrices[0]?.actual_price
        ? Number(product.productPrices[0].actual_price)
        : undefined,
      currentMarketPrice: product.productPrices[0]?.market_price
        ? Number(product.productPrices[0].market_price)
        : undefined,
      lowStockThreshold: 10,
    };
  },
  ["product-details"],
  { tags: [TAGS.PRODUCT], revalidate: REVAL.MEDIUM }
);



// Cached warehouse function
  const getCachedWarehouseList = unstable_cache(
    async (orgId: string) => {
      const bigOrgId = BigInt(orgId);
      const rows = await prisma.warehouse.findMany({
        where: { org_id: bigOrgId },
        select: { warehouse_id: true, name: true, address: true },
        orderBy: { name: "asc" },
      });

      return rows.map((w) => ({
        id: w.warehouse_id.toString(),
        name: w.name || "Unnamed Warehouse",
        address: w.address || "",
      }));
    },
    ["warehouse-list"],
    { tags: [TAGS.WAREHOUSE], revalidate: REVAL.LONG }
  );





// Cache user lookup to avoid repeated queries
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
  }
  
  return user;
}

async function getOrCreateDefaultWarehouse(orgId: BigInt) {
  let warehouse = await prisma.warehouse.findFirst({
    where: { org_id: Number(orgId)},
    select: { warehouse_id: true, name: true }
  });
  
  if (!warehouse) {
    warehouse = await prisma.warehouse.create({
      data: {
        org_id: Number(orgId),
        name: 'Default Warehouse',
        address: 'Default Address',
      },
      select: { warehouse_id: true, name: true }
    });
  }
  
  return warehouse;
}

export async function addProduct(
  orgId: string,
  productData: {
    name: string;
    sku: string;
    stock: number;
    price: number;
    image?: string | null;
    description?: string;
  }
) {
  const { userId } = await verifyPermissions(orgId, ["writer", "read-write", "admin"]);

  try {
    const bigOrgId = BigInt(orgId);
    const user = await getOrCreateUser(userId);
    const warehouse = await getOrCreateDefaultWarehouse(bigOrgId);

    const product = await prisma.$transaction(async (tx) => {
      const newProduct = await tx.product.create({
        data: {
          org_id: bigOrgId,
          name: productData.name,
          sku: productData.sku,
          description: productData.description || null,
          image_url: productData.image || null,
          status: "active",
          created_by: user.user_id,
          modified_by: user.user_id,
        },
        select: { product_id: true, name: true, sku: true },
      });

      await tx.productStock.create({
        data: {
          product_id: newProduct.product_id,
          warehouse_id: warehouse.warehouse_id,
          quantity: productData.stock,
        },
      });

      await tx.productPrice.create({
        data: {
          product_id: newProduct.product_id,
          retail_price: productData.price,
          valid_from: new Date(),
        },
      });

      return newProduct;
    });

    // CRITICAL: Comprehensive cache invalidation
    // This ensures server-side caches are cleared
    await Promise.all([
      CacheService.invalidateProducts(orgId),
      revalidateTag(`org-products-${orgId}`),
      revalidateTag(`product-${product.product_id.toString()}`),
      revalidateTag("products"),
      // Invalidate both the list page and any detail pages
      revalidatePath("/inventory", "page"),
      revalidatePath(`/inventory/${product.product_id.toString()}`, "page"),
      // Also invalidate the layout to be safe
      revalidatePath("/inventory", "layout"),
    ]);

    console.log(`✅ Product created: ${product.product_id} (${product.name})`);
    
    return {
      success: true,
      productId: product.product_id.toString(),
      message: `Product "${product.name}" added successfully`,
    };
  } catch (error) {
    console.error("Error adding product:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("unique_sku_per_organization")) {
        throw new Error(`SKU "${productData.sku}" already exists in this organization`);
      }
      throw error;
    }
    
    throw new Error("Failed to add product. Please try again.");
  }
}


export async function updateProduct(
  orgId: string,
  productId: string,
  productData: {
    name: string;
    sku: string;
    stock: number;
    price: number;
    image?: string | null;
    description?: string;
  }
) {
  const { userId } = await verifyPermissions(orgId, ["writer", "read-write", "admin"]);

  try {
    const bigOrgId = BigInt(orgId);
    const bigPid = BigInt(productId);
    const user = await getOrCreateUser(userId);

    const product = await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findFirst({
        where: { product_id: bigPid, org_id: bigOrgId },
        select: { product_id: true },
      });

      if (!existing) {
        throw new Error("Product not found in this organization");
      }

      const updated = await tx.product.update({
        where: { product_id: bigPid },
        data: {
          name: productData.name,
          sku: productData.sku,
          description: productData.description || null,
          image_url: productData.image || null,
          modified_by: user.user_id,
          updated_at: new Date(),
        },
        select: { name: true, product_id: true },
      });

      const stockEntry = await tx.productStock.findFirst({
        where: { product_id: bigPid },
        select: { stock_id: true },
      });

      if (stockEntry) {
        await tx.productStock.update({
          where: { stock_id: stockEntry.stock_id },
          data: { quantity: productData.stock },
        });
      }

      await tx.productPrice.updateMany({
        where: { product_id: bigPid, valid_to: null },
        data: { valid_to: new Date() },
      });

      await tx.productPrice.create({
        data: {
          product_id: bigPid,
          retail_price: productData.price,
          valid_from: new Date(),
        },
      });

      return updated;
    });

    // CRITICAL: Comprehensive cache invalidation
    await Promise.all([
      CacheService.invalidateProducts(orgId),
      revalidateTag(`org-products-${orgId}`),
      revalidateTag(`product-${productId}`),
      revalidateTag("products"),
      revalidatePath("/inventory", "page"),
      revalidatePath(`/inventory/${productId}`, "page"),
      revalidatePath("/inventory", "layout"),
      // Also revalidate the API route
      revalidatePath(`/api/inventory/products`, "page"),
    ]);

    console.log(`✅ Product updated: ${productId} (${product.name})`);
    
    return {
      success: true,
      productId: product.product_id.toString(),
      message: `Product "${product.name}" updated successfully`,
    };
  } catch (error) {
    console.error("Error updating product:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("unique_sku_per_organization")) {
        throw new Error(`SKU "${productData.sku}" already exists in this organization`);
      }
      throw error;
    }
    
    throw new Error("Failed to update product. Please try again.");
  }
}


export async function deleteProduct(orgId: string, productId: string) {
  await verifyPermissions(orgId, ["writer", "read-write", "admin"]);

  try {
    const bigOrgId = BigInt(orgId);
    const bigPid = BigInt(productId);

    const [product, orderItems] = await Promise.all([
      prisma.product.findFirst({
        where: { product_id: bigPid, org_id: bigOrgId },
        select: { product_id: true, name: true },
      }),
      prisma.orderItem.findFirst({
        where: { product_id: bigPid },
        select: { order_item_id: true },
      }),
    ]);

    if (!product) {
      throw new Error("Product not found in this organization");
    }

    if (orderItems) {
      throw new Error(
        `Cannot delete product "${product.name}" because it has been ordered. ` +
        `Consider deactivating it instead.`
      );
    }

    await prisma.product.delete({
      where: { product_id: bigPid },
    });

    // CRITICAL: Comprehensive cache invalidation
    await Promise.all([
      CacheService.invalidateProducts(orgId),
      revalidateTag(`org-products-${orgId}`),
      revalidateTag(`product-${productId}`),
      revalidateTag("products"),
      revalidatePath("/inventory", "page"),
      revalidatePath(`/inventory/${productId}`, "page"),
      revalidatePath("/inventory", "layout"),
      revalidatePath(`/api/inventory/products`, "page"),
    ]);

    console.log(`✅ Product deleted: ${productId} (${product.name})`);
    
    return {
      success: true,
      productId: productId,
      message: `Product "${product.name}" deleted successfully`,
    };
  } catch (error) {
    console.error("Error deleting product:", error);
    
    if (error instanceof Error) {
      throw error;
    }
    
    throw new Error("Failed to delete product. Please try again.");
  }
}

// Bulk operations with optimized cache management
export async function bulkUpdateProducts(orgId: string, updates: { id: string; data: Omit<Product, 'id' | 'createdAt' | 'updatedAt'> }[]) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');
  if (!orgId) throw new Error('Organization ID is required');
  if (!updates || updates.length === 0) throw new Error('No updates provided');

  try {
    const bigOrgId = BigInt(orgId);
    
    // Ensure user is organization member and has proper role
    await ensureOrganizationMember(orgId);
    
    // Get user role after ensuring membership
    const role = await getUserRole(orgId);
    if (!hasPermission(role, ['writer', 'read-write', 'admin'])) {
      throw new Error('Insufficient permissions to update products');
    }

    const user = await getOrCreateUser(userId);

    // Perform bulk update using transaction
    const results = await prisma.$transaction(async (tx) => {
      const updateResults = [];
      
      for (const update of updates) {
        const productId = BigInt(update.id);
        
        // Update the product
        const updatedProduct = await tx.product.update({
          where: {
            product_id: productId,
            org_id: bigOrgId,
          },
          data: {
            name: update.data.name?.trim(),
            sku: update.data.sku?.trim(),
            description: update.data.description?.trim() ?? null,
            image_url: update.data.image?.trim() ?? null,
            modified_by: user.user_id,
          },
          select: { product_id: true, name: true, sku: true }
        });

        // Update stock if provided
        if (update.data.stock !== undefined) {
          const warehouse = await getOrCreateDefaultWarehouse(bigOrgId);
          
          // Find existing stock record first
          const existingStock = await tx.productStock.findFirst({
            where: {
              product_id: productId,
              warehouse_id: warehouse.warehouse_id,
            },
            select: { stock_id: true }
          });

          if (existingStock) {
            // Update existing stock
            await tx.productStock.update({
              where: { stock_id: existingStock.stock_id },
              data: { quantity: Math.max(0, update.data.stock) }
            });
          } else {
            // Create new stock record
            await tx.productStock.create({
              data: {
                product_id: productId,
                warehouse_id: warehouse.warehouse_id,
                quantity: Math.max(0, update.data.stock),
              }
            });
          }
        }

        // Update price if provided
        if (update.data.price !== undefined) {
          // Find existing price record
          const existingPrice = await tx.productPrice.findFirst({
            where: { product_id: productId },
            orderBy: { valid_from: 'desc' },
            select: { price_id: true }
          });

          if (existingPrice) {
            // Update existing price
            await tx.productPrice.update({
              where: { price_id: existingPrice.price_id },
              data: { retail_price: Math.max(0, update.data.price) }
            });
          } else {
            // Create new price record
            await tx.productPrice.create({
              data: {
                product_id: productId,
                retail_price: Math.max(0, update.data.price),
                valid_from: new Date(),
              }
            });
          }
        }

        updateResults.push({
          productId: updatedProduct.product_id.toString(),
          name: updatedProduct.name,
          sku: updatedProduct.sku,
        });
      }

      return updateResults;
    }, {
      maxWait: 10000, // Maximum time to wait for a transaction slot (10 seconds)
      timeout: 30000, // Maximum time for the transaction to run (30 seconds)
    });

    console.log(`bulkUpdateProducts: Successfully updated ${results.length} products`);

    // Invalidate cache once after all updates
    await CacheService.invalidateProducts(orgId);
    console.log(`bulkUpdateProducts: Cache invalidated for orgId: ${orgId}`);
    
    revalidatePath('/inventory');
    revalidatePath('/dashboard');
    revalidatePath(`/inventory/${orgId}`);

    return {
      success: true,
      updatedCount: results.length,
      results: results,
      message: `Successfully updated ${results.length} products`
    };

  } catch (error) {
    console.error("Bulk update products error:", error);
    
    if (error instanceof Error) {
      if (error.message.includes('Cannot convert') && error.message.includes('BigInt')) {
        throw new Error('Invalid organization or product ID format');
      }
      throw error;
    }
    
    throw new Error('Failed to update products. Please try again.');
  }
}

// Cache warming function for better performance
export async function warmupProductCache(orgId: string) {
  try {
    // Ensure user has permission to access this organization
    await ensureOrganizationMember(orgId);
    
    const role = await getUserRole(orgId);
    if (!hasPermission(role, ['reader', 'writer', 'read-write', 'admin'])) {
      throw new Error('Insufficient permissions to access products');
    }

    const bigOrgId = BigInt(orgId);
    
    // Fetch products from database
    const products = await prisma.product.findMany({
      where: { org_id: bigOrgId },
      include: {
        productStocks: true,
        productPrices: {
          orderBy: { valid_from: 'desc' },
          take: 1,
        },
      },
    });

 const mappedProducts: Product[] = products.map((p) => ({
  id: p.product_id.toString(),
  name: p.name || '',
  sku: p.sku || '',
  description: p.description || undefined,
  stock: p.productStocks.reduce((acc, s) => acc + (s.quantity || 0), 0),
  price: p.productPrices[0]?.retail_price?.toNumber() || 0,
  image: p.image_url || '',
  createdAt: p.created_at ? p.created_at.toISOString() : new Date().toISOString(),
  updatedAt: p.updated_at ? p.updated_at.toISOString() : new Date().toISOString(),
}));

    // Warm up the cache
    await CacheService.warmupCache(orgId, mappedProducts);
    
    console.log(`warmupProductCache: Warmed up cache for orgId: ${orgId} with ${mappedProducts.length} products`);
    
    return {
      success: true,
      cachedCount: mappedProducts.length,
      message: `Cache warmed up with ${mappedProducts.length} products`
    };

  } catch (error) {
    console.error('Error warming up product cache:', error);
    throw new Error(error instanceof Error ? error.message : 'Failed to warm up cache');
  }
}


export async function getProductDetails(orgId: string, productId: string) {
  if (!orgId || !productId) throw new Error("Missing required parameters");
  
  // Handle auth outside cache
  await getUserWithPermissions(orgId, ["reader", "writer", "read-write", "admin"]);
  
  try {
    // Call cached function
    return await getCachedProductDetails(orgId, productId);
  } catch (error) {
    console.error("Error fetching product details:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("Cannot convert") && error.message.includes("BigInt")) {
        throw new Error("Invalid product or organization ID format");
      }
      throw error;
    }
    
    throw new Error("Failed to fetch product details. Please try again.");
  }
}




export async function updateProductDetails(orgId: string, productId: string, data: any) {
  if (!orgId || !productId) throw new Error("Missing required parameters");
  
  const { userId } = await getUserWithPermissions(orgId, ["writer", "read-write", "admin"]);
  
  try {
    const bigOrgId = BigInt(orgId);
    const bigPid = BigInt(productId);

    const user = await prisma.user.findUnique({
      where: { clerk_id: userId },
      select: { user_id: true },
    });
    if (!user) throw new Error("User not found");

    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { product_id: bigPid, org_id: bigOrgId },
        data: {
          name: data.name?.trim(),
          sku: data.sku?.trim(),
          description: data.description?.trim(),
          image_url: data.image?.trim(),
          status: data.status?.trim(),
          modified_by: user.user_id,
        },
      });

      if (
        data.price !== undefined ||
        data.actualPrice !== undefined ||
        data.marketPrice !== undefined
      ) {
        await tx.productPrice.updateMany({
          where: { product_id: bigPid, valid_to: null },
          data: { valid_to: new Date() },
        });
        await tx.productPrice.create({
          data: {
            product_id: bigPid,
            retail_price: data.price ?? 0,
            actual_price: data.actualPrice,
            market_price: data.marketPrice,
            valid_from: new Date(),
          },
        });
      }
    });

    revalidateTag(TAGS.PRODUCT);
    revalidatePath("/inventory");
    revalidatePath(`/inventory/${productId}`);

    return { success: true };
  } catch (error) {
    console.error("Error updating product details:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("Cannot convert") && error.message.includes("BigInt")) {
        throw new Error("Invalid product or organization ID format");
      }
      throw error;
    }
    
    throw new Error("Failed to update product. Please try again.");
  }
}

export async function deleteProductDetails(orgId: string, productId: string) {
  if (!orgId || !productId) throw new Error("Missing required parameters");
  
  await getUserWithPermissions(orgId, ["writer", "read-write", "admin"]);
  
  try {
    const bigPid = BigInt(productId);
    const bigOrgId = BigInt(orgId);

    // Check if product exists and get more details for better error handling
    const [product, orderItems] = await Promise.all([
      prisma.product.findFirst({
        where: { product_id: bigPid, org_id: bigOrgId },
        select: { 
          product_id: true, 
          name: true, 
          status: true,
          _count: {
            select: {
              productStocks: true,
              productPrices: true
            }
          }
        },
      }),
      prisma.orderItem.findMany({
        where: { product_id: bigPid },
        select: { 
          order_item_id: true,
          order: {
            select: {
              order_id: true,
              order_date: true,
              customer_name: true,
              status: true
            }
          }
        },
        take: 5 // Get first few order references
      }),
    ]);

    if (!product) {
      throw new Error("Product not found in this organization");
    }

    if (orderItems.length > 0) {
      // Provide more detailed error with order information
      const orderDetails = orderItems.map(item => 
        `Order #${item.order.order_id} (${item.order.customer_name || 'Unknown Customer'})`
      ).slice(0, 3).join(', ');
      
      const moreOrders = orderItems.length > 3 ? ` and ${orderItems.length - 3} more` : '';
      
      throw new Error(
        `Cannot delete product "${product.name}" because it has been ordered. ` +
        `Referenced in: ${orderDetails}${moreOrders}. ` +
        `Consider deactivating the product instead.`
      );
    }

    // Check if product has stock (optional warning, but allow deletion)
    const totalStock = await prisma.productStock.aggregate({
      where: { product_id: bigPid },
      _sum: { quantity: true }
    });

    if ((totalStock._sum.quantity || 0) > 0) {
      console.warn(`Deleting product ${productId} with ${totalStock._sum.quantity} units in stock`);
    }

    // Delete product (cascading will handle related records)
    await prisma.product.delete({ where: { product_id: bigPid } });
    
    console.log(`Successfully deleted product ${productId} (${product.name})`);
    
    revalidateTag(TAGS.PRODUCT);
    revalidatePath("/inventory");
    
    return { 
      success: true,
      productId: productId.toString(),
      productName: product.name,
      message: `Product "${product.name}" has been successfully deleted`
    };
  } catch (error) {
    console.error("Error deleting product:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("Cannot convert") && error.message.includes("BigInt")) {
        throw new Error("Invalid organization or product ID format");
      }
      // Re-throw our custom error messages
      throw error;
    }
    
    throw new Error("Failed to delete product. Please try again.");
  }
}

export async function updateProductStock(orgId: string, productId: string, warehouseId: string, adjustment: number) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');
  if (!orgId) throw new Error('Organization ID is required');
  if (!productId) throw new Error('Product ID is required');
  if (!warehouseId) throw new Error('Warehouse ID is required');

  try {
    const bigOrgId = BigInt(orgId);
    const bigProductId = BigInt(productId);
    const bigWarehouseId = BigInt(warehouseId);
    
    await ensureOrganizationMember(orgId);
    
    const role = await getUserRole(orgId);
    if (!hasPermission(role, ['writer', 'read-write', 'admin'])) {
      throw new Error('Insufficient permissions to update stock');
    }

    const user = await getOrCreateUser(userId);

    await prisma.$transaction(async (tx) => {
      // Find existing stock record
      const existingStock = await tx.productStock.findFirst({
        where: {
          product_id: bigProductId,
          warehouse_id: bigWarehouseId
        },
        select: { stock_id: true, quantity: true }
      });

      const newQuantity = (existingStock?.quantity || 0) + adjustment;
      
      if (newQuantity < 0) {
        throw new Error('Insufficient stock for this adjustment');
      }

      if (existingStock) {
        // Update existing stock record
        await tx.productStock.update({
          where: { stock_id: existingStock.stock_id },
          data: { quantity: newQuantity }
        });
      } else {
        // Create new stock record
        await tx.productStock.create({
          data: {
            product_id: bigProductId,
            warehouse_id: bigWarehouseId,
            quantity: Math.max(0, adjustment)
          }
        });
      }

      // Log the stock movement
      await tx.stockMovement.create({
        data: {
          product_id: bigProductId,
          warehouse_id: bigWarehouseId,
          type: adjustment > 0 ? 'in' : 'out',
          quantity: Math.abs(adjustment),
          reason: adjustment > 0 ? 'Stock increase' : 'Stock decrease',
          created_by: user.user_id
        }
      });
    });

    // Invalidate cache
    await CacheService.invalidateProducts(orgId);
    
    revalidatePath('/inventory');
    revalidatePath(`/inventory/${productId}`);

    return { success: true };

  } catch (error) {
    console.error('Error updating product stock:', error);
    
    if (error instanceof Error) {
      throw error;
    }
    
    throw new Error('Failed to update stock. Please try again.');
  }
}

// Transfer stock between warehouses
export async function transferStock(
  orgId: string,
  productId: string,
  fromWarehouseId: string,
  toWarehouseId: string,
  quantity: number,
  reason: string,
  notes?: string
) {
  if (!orgId || !productId || !fromWarehouseId || !toWarehouseId) {
    throw new Error("Missing required parameters");
  }
  
  const { userId } = await getUserWithPermissions(orgId, ["writer", "read-write", "admin"]);
  
  try {
    const bigOrgId = BigInt(orgId);
    const bigPid = BigInt(productId);
    const bigFromWarehouse = BigInt(fromWarehouseId);
    const bigToWarehouse = BigInt(toWarehouseId);

    const user = await prisma.user.findUnique({
      where: { clerk_id: userId },
      select: { user_id: true },
    });
    if (!user) throw new Error("User not found");

    await prisma.$transaction(async (tx) => {
      // Get current stock levels
      const fromStock = await tx.productStock.findFirst({
        where: { product_id: bigPid, warehouse_id: bigFromWarehouse },
      });

      if (!fromStock || fromStock.quantity < quantity) {
        throw new Error("Insufficient stock in source warehouse");
      }

      // Update source warehouse
      await tx.productStock.update({
        where: { stock_id: fromStock.stock_id },
        data: { quantity: fromStock.quantity - quantity },
      });

      // Update or create destination warehouse stock
      const toStock = await tx.productStock.findFirst({
        where: { product_id: bigPid, warehouse_id: bigToWarehouse },
      });

      if (toStock) {
        await tx.productStock.update({
          where: { stock_id: toStock.stock_id },
          data: { quantity: toStock.quantity + quantity },
        });
      } else {
        await tx.productStock.create({
          data: {
            product_id: bigPid,
            warehouse_id: bigToWarehouse,
            quantity: quantity,
          },
        });
      }

      // Log the transfer (if you have a transfer log table)
      // await tx.stockTransfer.create({
      //   data: {
      //     product_id: bigPid,
      //     from_warehouse_id: bigFromWarehouse,
      //     to_warehouse_id: bigToWarehouse,
      //     quantity: quantity,
      //     reason: reason,
      //     notes: notes,
      //     transferred_by: user.user_id,
      //     transferred_at: new Date(),
      //   },
      // });
    });

    revalidateTag(TAGS.PRODUCT);
    revalidateTag(TAGS.WAREHOUSE);
    revalidatePath("/inventory");
    revalidatePath(`/inventory/${productId}`);

    return { success: true };
  } catch (error) {
    console.error("Error transferring stock:", error);
    
    if (error instanceof Error) {
      throw error;
    }
    
    throw new Error("Failed to transfer stock. Please try again.");
  }
} 

export async function getWarehousesWithStock(orgId: string, productId: string) {
  if (!orgId) throw new Error("Organization ID is required");
  if (!productId) throw new Error("Product ID is required");
  
  await getUserWithPermissions(orgId, ["reader", "writer", "read-write", "admin"]);
  
  try {
    return await getCachedWarehousesWithStock(orgId, productId);
  } catch (error) {
    console.error("Error fetching warehouses with stock:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("Cannot convert") && error.message.includes("BigInt")) {
        throw new Error("Invalid organization or product ID format");
      }
      throw error;
    }
    
    throw new Error("Failed to fetch warehouse stock data. Please try again.");
  }
}

// Cached version
const getCachedWarehousesWithStock = unstable_cache(
  async (orgId: string, productId: string) => {
    const bigOrgId = BigInt(orgId);
    const bigProductId = BigInt(productId);

    const warehouses = await prisma.warehouse.findMany({
      where: { org_id: bigOrgId },
      include: {
        productStocks: {
          where: { product_id: bigProductId },
          select: {
            quantity: true,
            stock_id: true,
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    return warehouses.map(warehouse => ({
      id: warehouse.warehouse_id.toString(),
      name: warehouse.name || 'Unnamed Warehouse',
      address: warehouse.address || '',
      currentStock: warehouse.productStocks[0]?.quantity ?? 0,
    }));
  },
  ["warehouses-with-stock"],
  {
    tags: [TAGS.WAREHOUSE, TAGS.PRODUCT], // Add your cache tags
    revalidate: 60, // Cache for 60 seconds
  }
);


export async function deactivateProduct(orgId: string, productId: string, reason?: string) {
  if (!orgId || !productId) throw new Error("Missing required parameters");
  
  const { userId } = await getUserWithPermissions(orgId, ["writer", "read-write", "admin"]);
  
  try {
    const bigOrgId = BigInt(orgId);
    const bigPid = BigInt(productId);

    const user = await prisma.user.findUnique({
      where: { clerk_id: userId },
      select: { user_id: true },
    });
    if (!user) throw new Error("User not found");

    const product = await prisma.product.update({
      where: { product_id: bigPid, org_id: bigOrgId },
      data: {
        status: "discontinued",
        modified_by: user.user_id,
        // If you have a reason field, add it here
        // deactivation_reason: reason,
        // deactivated_at: new Date(),
      },
      select: { name: true }
    });

    revalidateTag(TAGS.PRODUCT);
    revalidatePath("/inventory");
    revalidatePath(`/inventory/${productId}`);

    return { 
      success: true,
      productId: productId.toString(),
      productName: product.name,
      message: `Product "${product.name}" has been deactivated`
    };
  } catch (error) {
    console.error("Error deactivating product:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("Cannot convert") && error.message.includes("BigInt")) {
        throw new Error("Invalid organization or product ID format");
      }
      throw error;
    }
    
    throw new Error("Failed to deactivate product. Please try again.");
  }
}


export async function activateProduct(orgId: string, productId: string) {
  if (!orgId || !productId) throw new Error("Missing required parameters");
  
  const { userId } = await getUserWithPermissions(orgId, ["writer", "read-write", "admin"]);
  
  try {
    const bigOrgId = BigInt(orgId);
    const bigPid = BigInt(productId);

    const user = await prisma.user.findUnique({
      where: { clerk_id: userId },
      select: { user_id: true },
    });
    if (!user) throw new Error("User not found");

    const product = await prisma.product.update({
      where: { product_id: bigPid, org_id: bigOrgId },
      data: {
        status: "active",
        modified_by: user.user_id,
        // If you track activation timestamps
        // activated_at: new Date(),
      },
      select: { name: true, status: true }
    });

    revalidateTag(TAGS.PRODUCT);
    revalidatePath("/inventory");
    revalidatePath(`/inventory/${productId}`);

    return { 
      success: true,
      productId: productId.toString(),
      productName: product.name,
      status: product.status,
      message: `Product "${product.name}" has been activated`
    };
  } catch (error) {
    console.error("Error activating product:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("Cannot convert") && error.message.includes("BigInt")) {
        throw new Error("Invalid organization or product ID format");
      }
      throw error;
    }
    
    throw new Error("Failed to activate product. Please try again.");
  }
}

export async function updateProductStatus(orgId: string, productId: string, status: 'active' | 'inactive' | 'discontinued') {
  if (!orgId || !productId) throw new Error("Missing required parameters");
  
  const { userId } = await getUserWithPermissions(orgId, ["writer", "read-write", "admin"]);
  
  try {
    const bigOrgId = BigInt(orgId);
    const bigPid = BigInt(productId);

    const user = await prisma.user.findUnique({
      where: { clerk_id: userId },
      select: { user_id: true },
    });
    if (!user) throw new Error("User not found");

    const product = await prisma.product.update({
      where: { product_id: bigPid, org_id: bigOrgId },
      data: {
        status: status,
        modified_by: user.user_id,
      },
      select: { name: true, status: true }
    });

    revalidateTag(TAGS.PRODUCT);
    revalidatePath("/inventory");
    revalidatePath(`/inventory/${productId}`);

    return { 
      success: true,
      productId: productId.toString(),
      productName: product.name,
      status: product.status,
      message: `Product "${product.name}" status updated to ${status}`
    };
  } catch (error) {
    console.error("Error updating product status:", error);
    throw new Error("Failed to update product status. Please try again.");
  }
}

export async function getWarehousesForDialog(orgId: string) {
  "use server";
  
  if (!orgId) throw new Error("Organization ID is required");
  
  try {
    await getUserWithPermissions(orgId, ["reader", "writer", "read-write", "admin"]);
    
    const bigOrgId = BigInt(orgId);
    
    // Direct fetch without caching for dialog use
    const warehouses = await prisma.warehouse.findMany({
      where: { org_id: bigOrgId },
      select: { 
        warehouse_id: true, 
        name: true, 
        address: true 
      },
      orderBy: { name: "asc" },
    });

    console.log('Fetched warehouses in action:', warehouses.length);

    return warehouses.map((w) => ({
      id: w.warehouse_id.toString(),
      name: w.name || "Unnamed Warehouse",
      address: w.address || "",
    }));
    
  } catch (error) {
    console.error("Error fetching warehouses for dialog:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("Cannot convert") && error.message.includes("BigInt")) {
        throw new Error("Invalid organization ID format");
      }
      throw error;
    }
    
    throw new Error("Failed to fetch warehouses. Please try again.");
  }
}