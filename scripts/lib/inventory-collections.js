/**
 * Single source of truth for the inventory collection names.
 *
 * The inventory schemas do not set `collection:` on their Mongoose factories, so the collection
 * name is whatever Mongoose pluralizes the model name into - `productvariants`,
 * `inventorymovements`, and so on. That is the same convention the rest of the app already
 * follows (`products`, `orders`, `trackingconfigs`).
 *
 * This module exists because hardcoding the names in the migration and verification scripts is
 * exactly how they came to disagree with the application: they used `product_variants` and
 * `inventory_balances`, created seven empty collections that nothing ever wrote to, and the
 * integrity script then reported CLEAN forever because it was inspecting the wrong collections.
 *
 * Both scripts resolve names through here, from the compiled schemas, so a schema change cannot
 * silently redirect them again.
 *
 * Requires `npm run build` first.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });
const path = require('path');
const mongoose = require('mongoose');

// scripts/lib -> backend root
const SCHEMA_DIR = path.resolve(__dirname, '../../dist/modules/inventory/schemas');

/**
 * Model class name -> schema module file. The class name is also the Mongoose model name, which
 * is what determines the collection name.
 */
const MODELS = {
  ProductOption: 'product-option.schema',
  ProductOptionValue: 'product-option-value.schema',
  ProductVariant: 'product-variant.schema',
  VariantOptionValue: 'variant-option-value.schema',
  InventoryBalance: 'inventory-balance.schema',
  InventoryMovement: 'inventory-movement.schema',
  InventoryReservation: 'inventory-reservation.schema',
};

let cached = null;

/** Real (pluralized) collection name for each inventory model, resolved from the schemas. */
function inventoryCollections() {
  if (cached) return cached;

  cached = {};
  for (const [className, file] of Object.entries(MODELS)) {
    const schemaPath = path.join(SCHEMA_DIR, file);
    let mod;
    try {
      mod = require(schemaPath);
    } catch (err) {
      throw new Error(
        `Could not load ${schemaPath}. Run "npm run build" before this script. (${err.message})`,
      );
    }

    const schemaKey = `${className}Schema`;
    const schema = mod[schemaKey];
    if (!schema) {
      throw new Error(`${schemaPath} does not export ${schemaKey}. Found: ${Object.keys(mod).join(', ')}`);
    }

    // The model name is what Mongoose pluralizes into the collection name, so it must be the
    // bare class name. Passing a third argument here would set the collection name explicitly
    // and defeat the whole purpose of resolving it.
    if (!mongoose.models[className]) mongoose.model(className, schema);

    cached[className] = mongoose.models[className].collection.name;
  }

  return cached;
}

/** Convenience aliases used throughout the scripts. */
function inventoryCollectionNames() {
  const c = inventoryCollections();
  return {
    options: c.ProductOption,
    optionValues: c.ProductOptionValue,
    variants: c.ProductVariant,
    joins: c.VariantOptionValue,
    balances: c.InventoryBalance,
    movements: c.InventoryMovement,
    reservations: c.InventoryReservation,
  };
}

module.exports = { inventoryCollections, inventoryCollectionNames };