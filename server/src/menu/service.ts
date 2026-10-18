import { and, asc, count, eq, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import {
  menuCategories,
  menuItems,
  type MenuCategory,
  type MenuItem,
  type UserRole,
} from '../db/schema.js';

export type CategoryInput = {
  name: string;
  sortOrder: number;
  isActive: boolean;
};
export type ItemInput = {
  categoryId: string;
  name: string;
  description?: string | null;
  priceMinor: number;
  sortOrder: number;
  isAvailable: boolean;
};

export class MenuService {
  constructor(private readonly database: AppDatabase) {}
  listCategories(role: UserRole, includeInactive: boolean) {
    return this.database.db
      .select()
      .from(menuCategories)
      .where(
        role === 'admin' && includeInactive
          ? undefined
          : eq(menuCategories.isActive, true),
      )
      .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name))
      .all();
  }
  createCategory(input: CategoryInput) {
    const now = new Date();
    const category: MenuCategory = {
      id: randomUUID(),
      name: normalizeName(input.name),
      sortOrder: input.sortOrder,
      isActive: input.isActive,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.database.db.insert(menuCategories).values(category).run();
    } catch (error) {
      this.handleConstraint(error, 'A category with this name already exists.');
    }
    return category;
  }
  updateCategory(id: string, input: Partial<CategoryInput>) {
    const existing = this.category(id);
    const values = {
      ...input,
      ...(input.name === undefined ? {} : { name: normalizeName(input.name) }),
      updatedAt: new Date(),
    };
    try {
      this.database.db
        .update(menuCategories)
        .set(values)
        .where(eq(menuCategories.id, id))
        .run();
    } catch (error) {
      this.handleConstraint(error, 'A category with this name already exists.');
    }
    return { ...existing, ...values };
  }
  listItems(options: {
    role: UserRole;
    categoryId?: string;
    search?: string;
    page: number;
    limit: number;
    includeArchived: boolean;
    includeUnavailable: boolean;
  }) {
    const filters: SQL[] = [];
    if (options.categoryId)
      filters.push(eq(menuItems.categoryId, options.categoryId));
    if (options.search) {
      const escaped = options.search.replace(/[\\%_]/g, '\\$&');
      filters.push(
        sql`(${menuItems.name} LIKE ${`%${escaped}%`} ESCAPE '\\' OR coalesce(${menuItems.description}, '') LIKE ${`%${escaped}%`} ESCAPE '\\')`,
      );
    }
    if (options.role !== 'admin' || !options.includeArchived)
      filters.push(eq(menuItems.isArchived, false));
    if (options.role !== 'admin' || !options.includeUnavailable)
      filters.push(eq(menuItems.isAvailable, true));
    if (options.role !== 'admin')
      filters.push(eq(menuCategories.isActive, true));
    const where = filters.length ? and(...filters) : undefined;
    const offset = (options.page - 1) * options.limit;
    const items = this.database.db
      .select({ item: menuItems, categoryName: menuCategories.name })
      .from(menuItems)
      .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
      .where(where)
      .orderBy(
        asc(menuCategories.sortOrder),
        asc(menuItems.sortOrder),
        asc(menuItems.name),
      )
      .limit(options.limit)
      .offset(offset)
      .all()
      .map((row) => ({ ...row.item, categoryName: row.categoryName }));
    const total = this.database.db
      .select({ value: count() })
      .from(menuItems)
      .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
      .where(where)
      .get()!.value;
    return {
      items,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        pages: Math.ceil(total / options.limit),
      },
    };
  }
  createItem(input: ItemInput) {
    this.category(input.categoryId);
    const now = new Date();
    const item: MenuItem = {
      id: randomUUID(),
      categoryId: input.categoryId,
      name: normalizeName(input.name),
      description: normalizeDescription(input.description),
      priceMinor: input.priceMinor,
      isAvailable: input.isAvailable,
      isArchived: false,
      sortOrder: input.sortOrder,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.database.db.insert(menuItems).values(item).run();
    } catch (error) {
      this.handleConstraint(
        error,
        'An item with this name already exists in the category.',
      );
    }
    return item;
  }
  updateItem(id: string, input: Partial<ItemInput>) {
    const existing = this.item(id);
    if (input.categoryId) this.category(input.categoryId);
    const values = {
      ...input,
      ...(input.name === undefined ? {} : { name: normalizeName(input.name) }),
      ...(input.description === undefined
        ? {}
        : { description: normalizeDescription(input.description) }),
      updatedAt: new Date(),
    };
    try {
      this.database.db
        .update(menuItems)
        .set(values)
        .where(eq(menuItems.id, id))
        .run();
    } catch (error) {
      this.handleConstraint(
        error,
        'An item with this name already exists in the category.',
      );
    }
    return { ...existing, ...values };
  }
  setAvailability(id: string, isAvailable: boolean) {
    return this.updateItem(id, { isAvailable });
  }
  setArchived(id: string, isArchived: boolean) {
    const item = this.item(id);
    const values = {
      isArchived,
      ...(isArchived ? { isAvailable: false } : {}),
      updatedAt: new Date(),
    };
    this.database.db
      .update(menuItems)
      .set(values)
      .where(eq(menuItems.id, id))
      .run();
    return { ...item, ...values };
  }
  private category(id: string) {
    const category = this.database.db
      .select()
      .from(menuCategories)
      .where(eq(menuCategories.id, id))
      .get();
    if (!category)
      throw new MenuError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
    return category;
  }
  private item(id: string) {
    const item = this.database.db
      .select()
      .from(menuItems)
      .where(eq(menuItems.id, id))
      .get();
    if (!item)
      throw new MenuError(404, 'ITEM_NOT_FOUND', 'Menu item not found.');
    return item;
  }
  private handleConstraint(error: unknown, message: string): never {
    if (
      error instanceof Error &&
      error.message.includes('UNIQUE constraint failed')
    )
      throw new MenuError(409, 'DUPLICATE_NAME', message);
    throw error;
  }
}
function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}
function normalizeDescription(value: string | null | undefined) {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  return normalized || null;
}
export class MenuError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
