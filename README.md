# BMI Health Tracker — 3-Tier Application with Full Observability Stack

A production-ready BMI/health metrics web application deployed across two AWS EC2 instances. The application tier collects BMI, BMR, and calorie data; the monitoring tier provides metrics, logs, alerting, and dashboards via Prometheus, Grafana, Loki, and AlertManager.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Repository Layout](#repository-layout)
3. [Prerequisites](#prerequisites)
4. [Local Development](#local-development)
5. [AWS Deployment](#aws-deployment)
   - [Step 1 — Provision EC2 Instances](#step-1--provision-ec2-instances)
   - [Step 2 — Deploy the Application Server](#step-2--deploy-the-application-server)
   - [Step 3 — Deploy the Monitoring Server](#step-3--deploy-the-monitoring-server)
   - [Step 4 — Wire the App Server Exporters](#step-4--wire-the-app-server-exporters)
6. [Port Reference](#port-reference)
7. [Environment Variables](#environment-variables)
8. [Database Migrations](#database-migrations)
9. [API Reference](#api-reference)
10. [Monitoring Stack](#monitoring-stack)
    - [Dashboards](#dashboards)
    - [Alert Rules](#alert-rules)
11. [Updating a Running Deployment](#updating-a-running-deployment)
12. [Code Navigation](#code-navigation)
13. [Design Decisions](#design-decisions)
14. [Dependencies](#dependencies)

---

## Architecture

```
                ┌─────────────────────────────────────────┐
                │           User's Browser                │
                └──────────────────┬──────────────────────┘
                                   │ :80 (HTTPS optional)
                ┌──────────────────▼────────────────────────┐
                │         bmi-app-server (EC2)              │
                │                                           │
                │  Nginx :80                                │
                │   ├── /          →  /var/www/bmi-health-  │
                │   │                 tracker (React build) │
                │   └── /api/*     →  localhost:3010        │
                │                                           │
                │  Node/Express :3010 (systemd)             │
                │   └── PostgreSQL :5432 (systemd)          │
                │        └── database: bmidb                │
                │                                           │
                │  Exporters (metrics → monitoring server)  │
                │   ├── Node Exporter        :9100          │
                │   ├── PostgreSQL Exporter  :9187          │
                │   ├── Nginx Exporter       :9113          │
                │   ├── BMI App Exporter     :9091 (PM2)    │
                │   └── Promtail             :9080          │
                └───────────────────────────────────────────┘
                          ↑ metrics pull (Prometheus)
                          ↑ logs push  (Promtail → Loki)

                ┌──────────────────────────────────────────┐
                │       bmi-monitoring-server (EC2)        │
                │                                          │
                │  Prometheus    :9090   (systemd)         │
                │  Grafana       :3001   (systemd)         │
                │  Loki          :3100   (systemd)         │
                │  AlertManager  :9093   (systemd)         │
                │  Node Exporter :9100   (systemd)         │
                └──────────────────────────────────────────┘
```

**Key design choices:**

- **Nginx as reverse proxy** — eliminates CORS issues in production by serving both static assets and the API from the same origin (`:80`).
- **Separate monitoring EC2** — ensures monitoring stays alive if the application server crashes.
- **Custom BMI App Exporter** — bridges business-level metrics (stored in PostgreSQL) to Prometheus without adding Prometheus client code to the application itself.
- **systemd for all long-running services** — restarts on failure, integrates with `journalctl`, survives reboots. PM2 is used only for the BMI App Exporter to simplify Node process management.

---

## Repository Layout

```
/
├── IMPLEMENTATION_AUTO.sh          # Automated app-server deployment (run as root/sudo)
├── IMPLEMENTATION_GUIDE.md         # Manual step-by-step equivalent of the above
├── Create-EC2-Instances.ps1        # Provisions both EC2 instances via AWS CLI (PowerShell)
├── .gitattributes                  # Enforces LF line endings for .sh/.yml files
│
├── backend/
│   ├── src/
│   │   ├── server.js               # Express entry point — PORT 3010
│   │   ├── routes.js               # All API route handlers
│   │   ├── calculations.js         # BMI, BMR, calorie formulas (pure functions)
│   │   └── db.js                   # pg connection pool (DATABASE_URL)
│   ├── migrations/
│   │   ├── 001_create_measurements.sql   # Creates measurements table
│   │   └── 002_add_measurement_date.sql  # Adds measurement_date column (idempotent)
│   ├── ecosystem.config.js         # PM2 config (dev convenience)
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx                 # Root component
│   │   ├── api.js                  # Axios client — all backend calls
│   │   ├── main.jsx                # React entry point
│   │   ├── index.css               # Global styles
│   │   └── components/
│   │       ├── MeasurementForm.jsx # BMI input form
│   │       └── TrendChart.jsx      # Chart.js 30-day trend chart
│   ├── vite.config.js              # Dev server :5173, proxy /api → :3010
│   └── package.json
│
├── database/
│   └── setup-database.sh           # Bootstraps PostgreSQL user + database
│
└── monitoring/
    ├── exporters/
    │   └── bmi-app-exporter/
    │       ├── exporter.js         # Custom Prometheus exporter — PORT 9091
    │       └── package.json
    │
    └── 3-tier-app/
        ├── config/
        │   ├── prometheus.yml      # 9 scrape jobs (app server + monitoring server)
        │   └── alert_rules.yml     # 3 alert groups (system / application / database)
        ├── dashboards/
        │   ├── three-tier-application-dashboard.json
        │   ├── loki-logs-dashboard.json
        │   ├── nodejs-runtime-dashboard.json
        │   ├── monitoring-server-health-dashboard.json
        │   └── bmi-business-metrics-dashboard.json
        └── scripts/
            ├── setup-monitoring-server.sh          # Automated monitoring server setup
            ├── setup-monitoring-server-guide.md    # Manual equivalent
            ├── setup-application-server.sh         # Automated exporter setup (run on app server)
            └── setup-application-server-guide.md  # Manual equivalent
```

---

## Prerequisites

### Local development

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 18 LTS | `node --version` |
| npm | ≥ 9 | Bundled with Node 18 |
| PostgreSQL | ≥ 14 | Running locally on :5432 |

### AWS deployment

| Requirement | Notes |
|---|---|
| AWS CLI v2 | Configured with `aws configure` |
| IAM permissions | EC2, VPC, Security Groups |
| Key pair | `.pem` file for SSH access |

---

## Local Development

### 1. Clone the repository

```bash
git clone https://github.com/sarowar-dev-ops/single-server-3tier-webapp-monitoring.git
cd single-server-3tier-webapp-monitoring
```

### 2. Bootstrap the database

Create the PostgreSQL user and database, then run migrations:

```bash
# Create user and database (adjust password as needed)
sudo -u postgres psql <<'EOF'
CREATE USER bmi_user WITH PASSWORD 'your_secure_password';
CREATE DATABASE bmidb OWNER bmi_user;
GRANT ALL PRIVILEGES ON DATABASE bmidb TO bmi_user;
EOF

# Run migrations
psql -U bmi_user -d bmidb -f backend/migrations/001_create_measurements.sql
psql -U bmi_user -d bmidb -f backend/migrations/002_add_measurement_date.sql
```

### 3. Configure the backend

```bash
cp backend/.env.example backend/.env
# Edit backend/.env:
#   DATABASE_URL=postgresql://bmi_user:your_secure_password@localhost:5432/bmidb
#   PORT=3010
#   NODE_ENV=development
```

### 4. Start the backend

```bash
cd backend
npm install
npm run dev       # nodemon — auto-reloads on file changes
```

Verify: `curl http://localhost:3010/health`
Expected: `{"status":"ok","environment":"development"}`

### 5. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser. The Vite dev server automatically proxies `/api/*` requests to `http://localhost:3010`.

### Stopping local services

```bash
# Stop frontend: Ctrl+C in the Vite terminal
# Stop backend:  Ctrl+C in the nodemon terminal
# Stop postgres (Linux): sudo systemctl stop postgresql
```

---

## AWS Deployment

The deployment splits across two EC2 instances. Start with the monitoring server because the application server's exporters need the Prometheus endpoint to be reachable at startup.

### Step 1 — Provision EC2 Instances

> **This creates real AWS resources that incur charges. Review the script first.**

```powershell
# Windows PowerShell (review and override the defaults inside the script first)
.\Create-EC2-Instances.ps1 -AwsProfile <aws-profile> -Region <region> -InstanceCount 2 -WaitForRunning
```

The script launches two instances — an application server and a monitoring
server — using the default VPC/subnet/security group/AMI defined in its `param`
block. Override those parameters (or edit the defaults) for your account, and
make sure the security group allows the required ports
(22/80/443/3010/9091/9100/9113/9187/9080 on the app server and
22/3001/9090/9093/3100/9100 on the monitoring server).

After completion, note both public IP addresses from the script output.

### Step 2 — Deploy the Application Server

SSH into the app server and run the automated deployment:

```bash
ssh -i your-key.pem ubuntu@<APP_SERVER_IP>

# Download and run the deployment script
curl -sSL https://raw.githubusercontent.com/sarowar-dev-ops/single-server-3tier-webapp-monitoring/main/IMPLEMENTATION_AUTO.sh | sudo bash
```

**Or** clone the full repo and run locally:

```bash
git clone https://github.com/sarowar-dev-ops/single-server-3tier-webapp-monitoring.git
cd single-server-3tier-webapp-monitoring
sudo bash IMPLEMENTATION_AUTO.sh
```

The script:
1. Installs PostgreSQL 14, Node.js 18 LTS, Nginx, PM2
2. Creates `bmidb` database and `bmi_user`
3. Runs both SQL migrations
4. Builds the React frontend and places output in `/var/www/bmi-health-tracker`
5. Configures Nginx to serve static files and proxy `/api/*` → `:3010`
6. Registers the backend as a systemd service (`bmi-backend.service`)
7. Opens UFW ports (22, 80, 443)

**Verify:**

```bash
systemctl status bmi-backend
curl http://localhost:3010/health
curl http://localhost/api/measurements
```

For a manual walkthrough, see [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md).

### Step 3 — Deploy the Monitoring Server

SSH into the monitoring server:

```bash
ssh -i your-key.pem ubuntu@<MONITORING_SERVER_IP>
git clone https://github.com/sarowar-dev-ops/single-server-3tier-webapp-monitoring.git
cd single-server-3tier-webapp-monitoring

# Set the app server IP before running
export APP_SERVER_IP=<APP_SERVER_IP>
sudo -E bash monitoring/3-tier-app/scripts/setup-monitoring-server.sh
```

The script installs and configures: Prometheus (`:9090`), Grafana (`:3001`), Loki (`:3100`), AlertManager (`:9093`), and Node Exporter (`:9100`). All 5 Grafana dashboards are provisioned automatically.

**Verify:**

```bash
systemctl status prometheus grafana-server loki alertmanager node_exporter
curl http://localhost:9090/-/ready
curl http://localhost:3001/api/health
```

Access Grafana at `http://<MONITORING_SERVER_IP>:3001` — default credentials: `admin` / `admin` (change on first login).

For a manual walkthrough, see [monitoring/3-tier-app/scripts/setup-monitoring-server-guide.md](monitoring/3-tier-app/scripts/setup-monitoring-server-guide.md).

### Step 4 — Wire the App Server Exporters

Back on the app server, install all Prometheus exporters and Promtail:

```bash
ssh -i your-key.pem ubuntu@<APP_SERVER_IP>
cd single-server-3tier-webapp-monitoring

export MONITORING_SERVER_IP=<MONITORING_SERVER_IP>
sudo -E bash monitoring/3-tier-app/scripts/setup-application-server.sh
```

The script installs: Node Exporter (`:9100`), PostgreSQL Exporter (`:9187`), Nginx Exporter (`:9113`), BMI App Exporter (`:9091`, PM2), and Promtail (`:9080`).

**Verify:**

```bash
curl http://localhost:9100/metrics | grep node_cpu
curl http://localhost:9091/metrics | grep bmi_
pm2 status
```

For a manual walkthrough, see [monitoring/3-tier-app/scripts/setup-application-server-guide.md](monitoring/3-tier-app/scripts/setup-application-server-guide.md).

---

## Port Reference

| Port | Service | Server | Notes |
|---|---|---|---|
| 80 | Nginx | App | Static files + `/api` proxy |
| 3010 | Node/Express backend | App | Internal only in prod |
| 5432 | PostgreSQL | App | Internal only |
| 9091 | BMI App Exporter | App | Custom Prometheus exporter |
| 9100 | Node Exporter | Both | OS/hardware metrics |
| 9113 | Nginx Exporter | App | Nginx stub_status metrics |
| 9187 | PostgreSQL Exporter | App | Database metrics |
| 9080 | Promtail | App | Log shipper (push to Loki) |
| 9090 | Prometheus | Monitoring | Metrics store + query engine |
| 3001 | Grafana | Monitoring | Dashboard UI |
| 3100 | Loki | Monitoring | Log aggregation |
| 9093 | AlertManager | Monitoring | Alert routing + silencing |
| 5173 | Vite dev server | Local | Dev only |

---

## Environment Variables

### `backend/.env`

| Variable | Example | Required | Description |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://bmi_user:pass@localhost:5432/bmidb` | Yes* | pg connection string |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `localhost` / `5432` / `bmidb` / `bmi_user` / `pass` | No | Fallback when `DATABASE_URL` is unset |
| `PORT` | `3010` | No | Defaults to `3010` |
| `NODE_ENV` | `production` | No | Enables prod CORS rules |
| `FRONTEND_URL` | `http://52.x.x.x` | No | Allowed CORS origin in prod |

\* Either `DATABASE_URL` or the individual `DB_*` variables are required.

The BMI App Exporter reads `backend/.env` if `DATABASE_URL` is not already set in the process environment, and uses the same connection fallback as the backend.

---

## Database Migrations

Migrations are plain SQL files in `backend/migrations/` and are run in order. Both are idempotent — safe to re-run.

```bash
# Run against local dev database
psql -U bmi_user -d bmidb -f backend/migrations/001_create_measurements.sql
psql -U bmi_user -d bmidb -f backend/migrations/002_add_measurement_date.sql

# Run against production database (from app server)
sudo -u postgres psql -d bmidb -f /opt/single-server-3tier-webapp-monitoring/backend/migrations/001_create_measurements.sql
sudo -u postgres psql -d bmidb -f /opt/single-server-3tier-webapp-monitoring/backend/migrations/002_add_measurement_date.sql
```

**Schema — `measurements` table:**

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PRIMARY KEY | |
| `weight_kg` | NUMERIC(5,2) | CHECK > 0 and < 1000 |
| `height_cm` | NUMERIC(5,2) | CHECK > 0 and < 300 |
| `age` | INTEGER | CHECK > 0 and < 150 |
| `sex` | VARCHAR(10) | `male` or `female` |
| `activity_level` | VARCHAR(30) | sedentary / light / moderate / active / very_active |
| `bmi` | NUMERIC(4,1) | Calculated: `weight / (height_m)²` |
| `bmi_category` | VARCHAR(30) | Underweight / Normal / Overweight / Obese |
| `bmr` | INTEGER | Mifflin-St Jeor equation |
| `daily_calories` | INTEGER | BMR × activity multiplier |
| `measurement_date` | DATE | NOT NULL, DEFAULT CURRENT_DATE |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() |

---

## API Reference

Base URL (production): `http://<APP_SERVER_IP>/api`  
Base URL (development): `http://localhost:3010/api`

---

### `POST /api/measurements`

Create a new measurement. The server calculates BMI, BMR, and daily calories.

**Request body:**

```json
{
  "weightKg": 65,
  "heightCm": 165,
  "age": 30,
  "sex": "female",
  "activity": "moderate",
  "measurementDate": "2024-01-15"
}
```

`weightKg`, `heightCm`, `age`, and `sex` are required. `activity` defaults to
`sedentary`; `measurementDate` defaults to today (UTC).

**Activity level values:** `sedentary` · `light` · `moderate` · `active` · `very_active`

**Response `201`:**

```json
{
  "measurement": {
    "id": 42,
    "weight_kg": "65.00",
    "height_cm": "165.00",
    "age": 30,
    "sex": "female",
    "activity_level": "moderate",
    "bmi": "23.9",
    "bmi_category": "Normal",
    "bmr": 1467,
    "daily_calories": 2274,
    "measurement_date": "2024-01-15T00:00:00.000Z",
    "created_at": "2024-01-15T10:30:00.000Z"
  }
}
```

`NUMERIC` columns are returned as strings by `node-postgres`.

---

### `GET /api/measurements`

Returns all measurements, most recent first.

**Response `200`:**

```json
{ "rows": [ { "id": 42, "bmi": "23.9", "...": "..." } ] }
```

---

### `GET /api/measurements/trends`

Returns daily BMI averages for the past 30 days.

**Response `200`:**

```json
{
  "rows": [
    { "day": "2024-01-15T00:00:00.000Z", "avg_bmi": "23.9" },
    { "day": "2024-01-14T00:00:00.000Z", "avg_bmi": "24.1" }
  ]
}
```

---

### `GET /health`

Liveness probe for the Express process (does not query the database).

**Response `200`:**

```json
{ "status": "ok", "environment": "production" }
```

> Database connectivity is exposed by the exporter at `http://localhost:9091/health`.

---

## Monitoring Stack

### Component Overview

| Component | Version | Role |
|---|---|---|
| Prometheus | 2.48.0 | Metrics scraping, storage, alerting rules |
| Grafana | Latest | Dashboard UI, data source proxy |
| Loki | 2.9.3 | Log aggregation and querying |
| AlertManager | 0.26.0 | Alert routing, deduplication, silencing |
| Node Exporter | 1.7.0 | OS metrics (CPU, memory, disk, network) |
| PostgreSQL Exporter | 0.15.0 | Database metrics (connections, queries, locks) |
| Nginx Exporter | 0.11.0 | Request rate, active connections |
| BMI App Exporter | Custom | Business metrics from the `measurements` table |
| Promtail | 2.9.3 | Tails logs from app server → pushes to Loki |

### Prometheus Scrape Jobs

Defined in `monitoring/3-tier-app/config/prometheus.yml`:

| Job | Target | What it scrapes |
|---|---|---|
| `prometheus` | monitoring:9090 | Prometheus self-metrics |
| `node_exporter` | app:9100 | App server OS metrics |
| `postgresql` | app:9187 | PostgreSQL metrics |
| `nginx` | app:9113 | Nginx metrics |
| `bmi-backend` | app:9091 | BMI business metrics |
| `node_exporter_monitoring` | monitoring:9100 | Monitoring server OS metrics |
| `grafana` | monitoring:3001 | Grafana internal metrics |
| `loki` | monitoring:3100 | Loki internal metrics |
| `alertmanager` | monitoring:9093 | AlertManager internal metrics |

### Dashboards

All dashboards are auto-provisioned when `setup-monitoring-server.sh` runs. They are stored in `monitoring/3-tier-app/dashboards/`.

| Dashboard | Focus |
|---|---|
| `three-tier-application-dashboard.json` | Application health — request rates, errors, response times |
| `loki-logs-dashboard.json` | Log viewer — filter by service, level, search body |
| `nodejs-runtime-dashboard.json` | Node.js runtime — heap, GC, event loop lag |
| `monitoring-server-health-dashboard.json` | Monitoring server OS health — CPU, memory, disk |
| `bmi-business-metrics-dashboard.json` | Business KPIs — measurements/day, BMI distribution, category breakdown |

To import a dashboard manually: Grafana → Dashboards → Import → Upload JSON.

### Alert Rules

Defined in `monitoring/3-tier-app/config/alert_rules.yml`, grouped into three groups:

**`system_alerts`**
- `HighCPUUsage` — `avg(rate(node_cpu_seconds_total{mode!="idle"}[5m])) > 0.8` for 5 min
- `HighMemoryUsage` — used memory > 85% for 5 min
- `DiskSpaceLow` — disk used > 85% for 5 min

**`application_alerts`**
- `ApplicationDown` — `bmi-backend` target `up == 0` for 1 min
- `MonitoringServiceDown` — any monitoring component `up == 0` for 1 min
- `DatabaseDown` — `postgresql` exporter `up == 0` for 1 min
- `NginxDown` — `nginx` exporter `up == 0` for 1 min

**`database_alerts`**
- `HighDatabaseConnections` — active connections > 80 for 5 min

AlertManager configuration: `monitoring/alertmanager/alertmanager.yml` — configure SMTP/Slack/PagerDuty receivers there before deploying.

---

## Updating a Running Deployment

### Application code change

```bash
# On the app server
cd /opt/single-server-3tier-webapp-monitoring   # adjust path if different
git pull origin main

# If backend changed:
sudo systemctl restart bmi-backend
sudo systemctl status bmi-backend

# If frontend changed:
cd frontend && npm ci && npm run build
sudo cp -r dist/* /var/www/bmi-health-tracker/
sudo systemctl reload nginx

# If a new migration was added:
sudo -u postgres psql -d bmidb -f backend/migrations/<new_migration>.sql
```

### Monitoring config change (prometheus.yml / alert_rules.yml)

```bash
# On the monitoring server — reload without downtime
curl -X POST http://localhost:9090/-/reload

# Verify the new config was accepted:
curl http://localhost:9090/api/v1/status/config | python3 -m json.tool | grep -A2 scrape_configs
```

### Dashboard change

```bash
# On the monitoring server — copy updated JSON files
sudo cp monitoring/3-tier-app/dashboards/*.json /etc/grafana/provisioning/dashboards/
# Grafana polls for file changes every 30 seconds automatically.
# Or trigger an immediate reload:
curl -u admin:admin -X POST http://localhost:3001/api/admin/provisioning/dashboards/reload
```

### Exporter or Promtail change

```bash
# On the app server
git pull origin main

# For systemd-managed exporters (node_exporter, postgres_exporter, nginx_exporter):
sudo systemctl restart <service-name>

# For BMI App Exporter (PM2):
cd monitoring/exporters/bmi-app-exporter
npm ci
pm2 restart bmi-app-exporter
pm2 save
```

---

## Code Navigation

### Making a backend API change

1. Edit the relevant handler in `backend/src/routes.js`
2. If the change involves calculations, update `backend/src/calculations.js`
3. If the change requires a schema change, add a new numbered SQL file to `backend/migrations/`
4. Test locally: `curl http://localhost:3010/api/measurements`
5. Deploy: `git push origin main`, then `systemctl restart bmi-backend` on the app server

### Adding a new metric to the custom exporter

1. Open `monitoring/exporters/bmi-app-exporter/exporter.js`
2. Register a new `prom-client` gauge/counter/histogram in the metrics definition section
3. Add a SQL query in the `collectMetrics()` function to populate it
4. Restart: `pm2 restart bmi-app-exporter`
5. Verify: `curl http://localhost:9091/metrics | grep <metric_name>`

### Adding a new dashboard

1. Build the dashboard in Grafana UI
2. Export as JSON (Dashboard settings → JSON Model)
3. Save to `monitoring/3-tier-app/dashboards/<name>.json`
4. Commit and push — the next run of `setup-monitoring-server.sh` will provision it automatically

### Adding a new alert rule

1. Edit `monitoring/3-tier-app/config/alert_rules.yml`
2. Add the same rule to the embedded `alert_rules.yml` in `setup-monitoring-server.sh` (the `cat > /etc/prometheus/alert_rules.yml` heredoc)
3. Reload Prometheus: `curl -X POST http://localhost:9090/-/reload`
4. Verify in Prometheus UI → Alerts

---

## Design Decisions

| Decision | Rationale |
|---|---|
| **Backend port 3010** instead of 3000 | Avoids collision with react-scripts default dev port on machines where both run simultaneously |
| **Grafana on port 3001** instead of 3000 | Port 3000 is commonly used by dev tools; 3001 avoids accidental conflicts on developer machines |
| **Two EC2 instances** not one | Monitoring must stay alive if the app server goes down — colocation defeats the purpose |
| **Custom BMI exporter** (separate process, port 9091) | Keeps Prometheus instrumentation outside the application domain; the exporter can fail without affecting the API |
| **systemd for all services** | OS-native supervision, journalctl integration, and automatic restart on failure |
| **PM2 for BMI App Exporter** | The exporter is a Node.js process — PM2 provides cluster mode and `npm ci`-based auto-restart without writing a systemd unit file |
| **Idempotent SQL migrations** | Migrations use `CREATE TABLE IF NOT EXISTS` and DO/exception blocks so they can be re-run safely during CI or re-provisioning |
| **LF-enforced `.gitattributes`** | Shell scripts cloned on Windows would get CRLF and fail on Linux with "bad interpreter" errors |

---

## Dependencies

### Backend (`backend/package.json`)

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.18.2 | HTTP server framework |
| `pg` | ^8.10.0 | PostgreSQL client (connection pool) |
| `cors` | ^2.8.5 | CORS middleware — controlled origin allowlist |
| `dotenv` | ^16.0.0 | Loads `.env` into `process.env` |
| `body-parser` | ^1.20.2 | JSON request body parsing |

Dev: `nodemon` for auto-reload during development.

### Frontend (`frontend/package.json`)

| Package | Version | Purpose |
|---|---|---|
| `react` | ^18.2.0 | UI framework |
| `react-dom` | ^18.2.0 | DOM renderer |
| `axios` | Latest | HTTP client for API calls |
| `chart.js` | ^4.4.0 | Canvas-based charting library |
| `react-chartjs-2` | Latest | React wrapper for Chart.js |
| `vite` | ^5.0.0 | Dev server + production bundler |

### BMI App Exporter (`monitoring/exporters/bmi-app-exporter/package.json`)

| Package | Version | Purpose |
|---|---|---|
| `prom-client` | ^15.0.0 | Prometheus metrics client (official Node library) |
| `express` | ^4.18.2 | HTTP server to expose `/metrics` endpoint |
| `pg` | ^8.10.0 | PostgreSQL client |
| `dotenv` | ^16.0.0 | Loads `backend/.env` for DATABASE_URL |

---

## 🧑‍💻 Author
*Md. Sarowar Alam*  
Lead DevOps Engineer, WPP Production - Dhaka  
📧 Email: sarowar@hotmail.com  
🔗 LinkedIn: https://www.linkedin.com/in/sarowar/

---
