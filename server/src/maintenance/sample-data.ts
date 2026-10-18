import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../db/database.js';
import { MenuService } from '../menu/service.js';

const configuredDirectory = process.env.POS_DATA_DIR;

if (!configuredDirectory || !path.isAbsolute(configuredDirectory)) {
  throw new Error(
    'Set POS_DATA_DIR to a new absolute test directory before loading sample data.',
  );
}

const dataDirectory = path.resolve(configuredDirectory);
const databaseFilename = path.join(dataDirectory, 'restaurant-pos.sqlite');

if (fs.existsSync(databaseFilename)) {
  throw new Error(
    `Refusing to modify an existing database: ${databaseFilename}`,
  );
}
if (
  fs.existsSync(dataDirectory) &&
  fs.readdirSync(dataDirectory, { withFileTypes: true }).length > 0
) {
  throw new Error(
    `POS_DATA_DIR must be new or empty. Refusing non-empty directory: ${dataDirectory}`,
  );
}

const database = openDatabase({ dataDirectory });

try {
  const menu = new MenuService(database);
  const seed = database.sqlite.transaction(() => {
    const definitions = [
      {
        name: 'برجر',
        items: [
          ['برجر كلاسيك', 'قطعة لحم مع خس وصوص المطعم', 9500],
          ['تشيز برجر', 'قطعة لحم مع جبنة وصوص المطعم', 11000],
          ['دبل برجر', 'قطعتان لحم مع جبنة', 15500],
        ],
      },
      {
        name: 'ساندوتشات',
        items: [
          ['شاورما فراخ', 'فراخ متبلة مع صوص الثومية', 9000],
          ['كفتة', 'كفتة مشوية مع طحينة', 10500],
          ['فراخ كرسبي', 'فراخ مقرمشة مع صوص', 12000],
        ],
      },
      {
        name: 'مشروبات',
        items: [
          ['مياه معدنية', null, 1500],
          ['كولا', null, 2500],
          ['عصير برتقال', 'عصير برتقال', 4500],
        ],
      },
      {
        name: 'إضافات',
        items: [
          ['بطاطس مقلية', 'بطاطس مقرمشة', 4000],
          ['حلقات بصل', 'حلقات بصل مقرمشة', 5500],
          ['كول سلو', 'سلطة كرنب', 3000],
        ],
      },
    ] as const;

    definitions.forEach((definition, categoryIndex) => {
      const category = menu.createCategory({
        name: definition.name,
        sortOrder: categoryIndex,
        isActive: true,
      });
      definition.items.forEach(([name, description, priceMinor], itemIndex) =>
        menu.createItem({
          categoryId: category.id,
          name,
          description,
          priceMinor,
          sortOrder: itemIndex,
          isAvailable: true,
        }),
      );
    });
  });

  seed.immediate();
  const integrity = database.sqlite.pragma('integrity_check', {
    simple: true,
  });
  if (integrity !== 'ok')
    throw new Error(`Integrity check failed: ${integrity}`);
  console.log(`Created isolated sample database: ${database.filename}`);
  console.log('Added 4 categories and 12 illustrative EGP-priced items.');
  console.log(
    'No users or credentials were created. Complete admin setup in the UI.',
  );
} finally {
  database.sqlite.close();
}
