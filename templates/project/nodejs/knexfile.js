require('dotenv').config();

// Build connection from DATABASE_URL or DB_* env vars
function getConnection() {
  // Prefer DATABASE_URL (postgresql:// with embedded credentials)
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    return { connectionString: dbUrl, ssl: { rejectUnauthorized: false } };
  }

  // Fallback: build from individual vars
  const host = process.env.LAKEBASE_HOST || process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const dbname = process.env.DB_NAME || 'databricks_postgres';
  const user = process.env.DB_USERNAME || '';
  const password = process.env.DB_PASSWORD || '';

  if (user && password) {
    return {
      connectionString: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${dbname}?sslmode=require`,
      ssl: { rejectUnauthorized: false },
    };
  }
  return { connectionString: `postgresql://${host}:${port}/${dbname}`, ssl: false };
}

module.exports = {
  client: 'pg',
  connection: getConnection(),
  migrations: {
    directory: './migrations',
  },
};
