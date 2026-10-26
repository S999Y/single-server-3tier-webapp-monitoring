// Load .env only if DATABASE_URL is not already set (production sets it via environment)
if (!process.env.DATABASE_URL) {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '../../../backend/.env') });
}
const express = require('express');
const promClient = require('prom-client');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.EXPORTER_PORT || 9091;

// Create a Registry
const register = new promClient.Registry();

// Add default metrics (CPU, memory, etc.)
promClient.collectDefaultMetrics({ 
  register,
  prefix: 'bmi_app_'
});

// Resolve the database name for pg_database_size()
function resolveDatabaseName() {
  if (process.env.DB_NAME) return process.env.DB_NAME;
  if (process.env.DATABASE_URL) {
    try {
      const name = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
      if (name) return decodeURIComponent(name);
    } catch (err) {
      console.warn('Could not parse database name from DATABASE_URL:', err.message);
    }
  }
  return 'bmidb';
}

const databaseName = resolveDatabaseName();

// Database connection pool
// DATABASE_URL takes precedence; otherwise fall back to individual DB_* vars
const connection = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: databaseName,
    };

const pool = new Pool({
  ...connection,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

// ==================== CUSTOM METRICS ====================

// Total measurements in database
const totalMeasurements = new promClient.Gauge({
  name: 'bmi_measurements_total',
  help: 'Total number of measurements stored in database',
  registers: [register]
});

// Measurements created in last 24 hours
const measurementsCreated24h = new promClient.Gauge({
  name: 'bmi_measurements_created_24h',
  help: 'Number of measurements created in last 24 hours',
  registers: [register]
});

// Measurements created in last 1 hour
const measurementsCreated1h = new promClient.Gauge({
  name: 'bmi_measurements_created_1h',
  help: 'Number of measurements created in last 1 hour',
  registers: [register]
});

// Average BMI value
const averageBMI = new promClient.Gauge({
  name: 'bmi_average_value',
  help: 'Average BMI value of all measurements',
  registers: [register]
});

// BMI category distribution
const bmiCategoryDistribution = new promClient.Gauge({
  name: 'bmi_category_count',
  help: 'Count of measurements by BMI category',
  labelNames: ['category'],
  registers: [register]
});

// Activity level distribution
const activityLevelDistribution = new promClient.Gauge({
  name: 'bmi_activity_level_count',
  help: 'Count of measurements by activity level',
  labelNames: ['activity_level'],
  registers: [register]
});

// Gender distribution
const genderDistribution = new promClient.Gauge({
  name: 'bmi_gender_count',
  help: 'Count of measurements by gender',
  labelNames: ['sex'],
  registers: [register]
});

// Database size
const databaseSize = new promClient.Gauge({
  name: 'bmi_database_size_bytes',
  help: 'Size of the bmidb database in bytes',
  registers: [register]
});

// Database table size
const tableSize = new promClient.Gauge({
  name: 'bmi_table_size_bytes',
  help: 'Size of the measurements table in bytes',
  registers: [register]
});

// Average age of users
const averageAge = new promClient.Gauge({
  name: 'bmi_average_age',
  help: 'Average age from all measurements',
  registers: [register]
});

// Average daily calories
const averageDailyCalories = new promClient.Gauge({
  name: 'bmi_average_daily_calories',
  help: 'Average daily calorie needs from all measurements',
  registers: [register]
});

// Database connection pool metrics
const dbPoolTotal = new promClient.Gauge({
  name: 'bmi_db_pool_total',
  help: 'Total number of clients in the pool',
  registers: [register]
});

const dbPoolIdle = new promClient.Gauge({
  name: 'bmi_db_pool_idle',
  help: 'Number of idle clients in the pool',
  registers: [register]
});

const dbPoolWaiting = new promClient.Gauge({
  name: 'bmi_db_pool_waiting',
  help: 'Number of clients waiting for a connection',
  registers: [register]
});

// Application health check
const appHealthy = new promClient.Gauge({
  name: 'bmi_app_healthy',
  help: 'Application health status (1 = healthy, 0 = unhealthy)',
  registers: [register]
});

// Metric collection errors
const metricsCollectionErrors = new promClient.Counter({
  name: 'bmi_metrics_collection_errors_total',
  help: 'Total number of errors during metrics collection',
  labelNames: ['error_type'],
  registers: [register]
});

// Last successful collection timestamp
const lastSuccessfulCollection = new promClient.Gauge({
  name: 'bmi_last_successful_collection_timestamp',
  help: 'Timestamp of last successful metrics collection',
  registers: [register]
});

// ==================== COLLECTION FUNCTIONS ====================

// Function to collect all metrics
async function collectMetrics() {
  try {
    console.log(`[${new Date().toISOString()}] Starting metrics collection...`);

    // Get pool statistics
    dbPoolTotal.set(pool.totalCount);
    dbPoolIdle.set(pool.idleCount);
    dbPoolWaiting.set(pool.waitingCount);

    // Total measurements
    const totalResult = await pool.query('SELECT COUNT(*) as count FROM measurements');
    const total = parseInt(totalResult.rows[0].count);
    totalMeasurements.set(total);
    console.log(`  - Total measurements: ${total}`);

    // Measurements in last 24 hours
    const last24hResult = await pool.query(
      "SELECT COUNT(*) as count FROM measurements WHERE created_at > NOW() - INTERVAL '24 hours'"
    );
    measurementsCreated24h.set(parseInt(last24hResult.rows[0].count));

    // Measurements in last 1 hour
    const last1hResult = await pool.query(
      "SELECT COUNT(*) as count FROM measurements WHERE created_at > NOW() - INTERVAL '1 hour'"
    );
    measurementsCreated1h.set(parseInt(last1hResult.rows[0].count));

    // Average BMI
    const avgBMIResult = await pool.query('SELECT AVG(bmi) as avg_bmi FROM measurements');
    if (avgBMIResult.rows[0].avg_bmi) {
      averageBMI.set(parseFloat(avgBMIResult.rows[0].avg_bmi));
    }

    // BMI category distribution
    const categoryResult = await pool.query(
      'SELECT bmi_category, COUNT(*) as count FROM measurements GROUP BY bmi_category'
    );
    categoryResult.rows.forEach(row => {
      if (row.bmi_category) {
        bmiCategoryDistribution.set({ category: row.bmi_category }, parseInt(row.count));
      }
    });

    // Activity level distribution
    const activityResult = await pool.query(
      'SELECT activity_level, COUNT(*) as count FROM measurements GROUP BY activity_level'
    );
    activityResult.rows.forEach(row => {
      if (row.activity_level) {
        activityLevelDistribution.set({ activity_level: row.activity_level }, parseInt(row.count));
      }
    });

    // Gender distribution
    const genderResult = await pool.query(
      'SELECT sex, COUNT(*) as count FROM measurements GROUP BY sex'
    );
    genderResult.rows.forEach(row => {
      if (row.sex) {
        genderDistribution.set({ sex: row.sex }, parseInt(row.count));
      }
    });

    // Database size
    const sizeResult = await pool.query(
      'SELECT pg_database_size($1) as size',
      [databaseName]
    );
    databaseSize.set(parseInt(sizeResult.rows[0].size));

    // Table size
    const tableSizeResult = await pool.query(
      "SELECT pg_total_relation_size('measurements') as size"
    );
    tableSize.set(parseInt(tableSizeResult.rows[0].size));

    // Average age
    const avgAgeResult = await pool.query('SELECT AVG(age) as avg_age FROM measurements');
    if (avgAgeResult.rows[0].avg_age) {
      averageAge.set(parseFloat(avgAgeResult.rows[0].avg_age));
    }

    // Average daily calories
    const avgCaloriesResult = await pool.query('SELECT AVG(daily_calories) as avg_calories FROM measurements');
    if (avgCaloriesResult.rows[0].avg_calories) {
      averageDailyCalories.set(parseFloat(avgCaloriesResult.rows[0].avg_calories));
    }

    // Mark application as healthy
    appHealthy.set(1);
    
    // Update last successful collection timestamp
    lastSuccessfulCollection.set(Date.now());

    console.log(`[${new Date().toISOString()}] Metrics collection completed successfully`);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error collecting metrics:`, error);
    metricsCollectionErrors.inc({ error_type: error.code || 'unknown' });
    appHealthy.set(0);
  }
}

// ==================== API ENDPOINTS ====================

// Metrics endpoint for Prometheus scraping
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    const metrics = await register.metrics();
    res.end(metrics);
  } catch (err) {
    console.error('Error generating metrics:', err);
    res.status(500).end(err.toString());
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  pool.query('SELECT 1')
    .then(() => {
      res.json({ 
        status: 'ok', 
        database: 'connected',
        timestamp: new Date().toISOString()
      });
    })
    .catch((err) => {
      res.status(500).json({ 
        status: 'error', 
        database: 'disconnected',
        error: err.message,
        timestamp: new Date().toISOString()
      });
    });
});

// Status endpoint with detailed information
app.get('/status', async (req, res) => {
  try {
    const dbInfo = await pool.query('SELECT version()');
    const totalMeas = await pool.query('SELECT COUNT(*) FROM measurements');
    
    res.json({
      exporter: {
        name: 'BMI App Exporter',
        version: '1.0.0',
        uptime: process.uptime(),
        pid: process.pid
      },
      database: {
        connected: true,
        version: dbInfo.rows[0].version,
        totalMeasurements: parseInt(totalMeas.rows[0].count)
      },
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      },
      lastCollection: new Date(lastSuccessfulCollection._value).toISOString()
    });
  } catch (error) {
    res.status(500).json({
      exporter: {
        name: 'BMI App Exporter',
        version: '1.0.0',
        uptime: process.uptime()
      },
      database: {
        connected: false,
        error: error.message
      }
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>BMI App Exporter</title></head>
      <body>
        <h1>BMI Health Tracker - Prometheus Exporter</h1>
        <p>This exporter provides custom application metrics for Prometheus.</p>
        <ul>
          <li><a href="/metrics">Metrics</a> - Prometheus metrics endpoint</li>
          <li><a href="/health">Health</a> - Health check endpoint</li>
          <li><a href="/status">Status</a> - Detailed status information</li>
        </ul>
        <p>Metrics are collected every 15 seconds.</p>
      </body>
    </html>
  `);
});

// ==================== STARTUP ====================

// Collect metrics initially
collectMetrics();

// Schedule metric collection every 15 seconds
const collectionInterval = setInterval(collectMetrics, 15000);

// Start the server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║       BMI Health Tracker - Prometheus Exporter            ║
╠═══════════════════════════════════════════════════════════╣
║  Status: Running                                          ║
║  Port: ${PORT}                                            ║
║  Metrics URL: http://localhost:${PORT}/metrics            ║
║  Health URL: http://localhost:${PORT}/health              ║
║  Collection Interval: 15 seconds                          ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server and database connections');
  clearInterval(collectionInterval);
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server and database connections');
  clearInterval(collectionInterval);
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});
