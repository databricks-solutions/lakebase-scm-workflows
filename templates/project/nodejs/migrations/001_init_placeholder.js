/**
 * Init placeholder migration. Add your first migration here.
 */
exports.up = function (knex) {
  // Example:
  // return knex.schema.createTable('book', (table) => {
  //   table.increments('id').primary();
  //   table.string('title', 255);
  //   table.decimal('price', 19, 2);
  //   table.date('publish_date');
  // });
};

exports.down = function (knex) {
  // Example:
  // return knex.schema.dropTableIfExists('book');
};
