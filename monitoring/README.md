# Monitoring — BMI Health Tracker

Complete observability stack for the BMI Health Tracker three-tier application.
Covers metrics collection, log aggregation, dashboarding, and alerting across two
dedicated EC2 servers.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Directory Structure](#3-directory-structure)
4. [How the Pieces Fit Together](#4-how-the-pieces-fit-together)
5. [Prerequisites](#5-prerequisites)
6. [Deployment](#6-deployment)
7. [Custom Application Exporter](#7-custom-application-exporter)
8. [Dashboards](#8-dashboards)
9. [Alert Rules Reference](#9-alert-rules-reference)
10. [Port Map and Network Policy](#10-port-map-and-network-policy)
11. [Day-2 Operations](#11-day-2-operations)
12. [Introducing Changes Safely](#12-introducing-changes-safely)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Architecture Overview

The system uses **two dedicated EC2 instances** with a strict separation of concerns:

```
┌──────────────────────────────────────────────────────────────────┐
│  BMI-ubuntu  (App Server)                                        │
│                                                                  │
│  ┌──────────┐  ┌───────────┐  ┌────────────────────────────┐     │
│  │  Nginx   │  │ BMI Node  │  │       PostgreSQL           │     │
│  │   :80    │  │ API :3010 │  │         :5432              │     │
│  └──────────┘  └───────────┘  └────────────────────────────┘     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Exporters  (only reachable from Monitoring private IP)  │    │
│  │  Node Exporter :9100 │ PG Exporter :9187                 │    │
│  │  Nginx Exporter :9113 │ BMI App Exporter :9091 (PM2)     │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Promtail :9080  ─── ships logs ──►  Loki                │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                     │ private IP scrape (pull)
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│  Monitoring-ubuntu  (Monitoring Server)                          │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────┐  ┌──────────────┐    │
│  │ Prometheus │  │  Grafana   │  │  Loki  │  │ AlertManager │    │
│  │   :9090    │  │   :3001    │  │ :3100  │  │    :9093     │    │
│  └────────────┘  └────────────┘  └────────┘  └──────────────┘    │
│                                                                  │
│  ┌──────────────────────┐                                        │
│  │ Node Exporter :9100  │  (self-monitors the monitoring server) │
│  └──────────────────────┘                                        │
└──────────────────────────────────────────────────────────────────┘
```

**Design decisions:**

| Decision | Rationale |
|---|---|
| Separate monitoring server | Monitoring survives application server failures. Alerts still fire even if the app host is down. |
| Exporter ports firewalled to monitoring IP only | Zero attack surface from the public internet. Each exporter port is allowed only from the monitoring server's private IP via UFW. |
| Pull-based scraping (Prometheus) | Centralised control. No credentials needed on the app server for metric delivery. |
| Push-based log shipping (Promtail → Loki) | Loki's push API is simpler than running a pull-based log exporter; Promtail also applies pipeline stages (regex labels) before shipping. |
| AlertManager not exposed to the internet | AlertManager runs on localhost only. Prometheus talks to it internally. This prevents spoofed alert silences from outside. |
| PM2 for BMI App Exporter | The custom exporter is a Node.js process. PM2 gives auto-restart, memory limits, and structured log rotation without needing a systemd unit file per environment. |
| 31-day log retention in Loki | Balances cost against the ability to investigate month-old incidents. Tunable via `limits_config.retention_period` in `loki/loki-config.yml`. |

---

## 2. Technology Stack

| Component | Technology | Version | Role |
|---|---|---|---|
| Metrics store | **Prometheus** | 2.48.0 | Scrapes all exporters every 15 s, stores TSDB for 30 days |
| Dashboards | **Grafana** | latest (apt) | Visualises Prometheus + Loki; auto-provisioned datasources and dashboards |
| Log aggregation | **Loki** | 2.9.3 | Receives log streams from Promtail; queried by Grafana |
| Log shipper | **Promtail** | 2.9.3 | Tails log files on app server; applies parsing pipeline; pushes to Loki |
| Alerting | **AlertManager** | 0.26.0 | Routes, deduplicates, and delivers alerts from Prometheus |
| System metrics | **Node Exporter** | 1.7.0 | CPU, memory, disk, network for both servers |
| DB metrics | **postgres_exporter** | 0.15.0 | PostgreSQL query stats, connection counts, database size |
| Web metrics | **nginx-prometheus-exporter** | 0.11.0 | Nginx active connections, accepted/handled counts |
| App metrics | **BMI App Exporter** | 1.0.0 (custom) | Business KPIs: measurement counts, BMI distribution, calorie averages |
| Exporter runtime | **Node.js** | 20.x LTS | Runs the custom exporter |
| Exporter process manager | **PM2** | latest | Auto-restart, memory ceiling, log rotation for app exporter |
| OS | **Ubuntu** | 22.04 LTS | Both servers |
| Cloud | **AWS EC2** | — | Both instances; IMDSv2 used for IP detection |

---

## 3. Directory Structure

```
monitoring/
├── README.md                          ← you are here
├── Automated_Setup_BMI_Monitoring.md  ← full two-server automated deployment guide
│
├── 3-tier-app/                        ← production config and scripts
│   ├── config/
│   │   ├── prometheus.yml             ← scrape jobs template (uses APPLICATION_SERVER_IP placeholder)
│   │   └── alert_rules.yml            ← all alert rules (5 groups, 20+ rules)
│   ├── dashboards/
│   │   ├── three-tier-application-dashboard.json
│   │   ├── loki-logs-dashboard.json
│   │   ├── nodejs-runtime-dashboard.json
│   │   ├── monitoring-server-health-dashboard.json
│   │   └── bmi-business-metrics-dashboard.json
│   └── scripts/
│       ├── setup-monitoring-server.sh       ← automated setup (Monitoring-ubuntu)
│       ├── setup-monitoring-server-guide.md ← manual step-by-step guide
│       ├── setup-application-server.sh      ← automated setup (App-ubuntu)
│       └── setup-application-server-guide.md← manual step-by-step guide
│
├── exporters/
│   └── bmi-app-exporter/
│       ├── exporter.js                ← custom Prometheus exporter (Node.js / prom-client)
│       ├── package.json
│       └── ecosystem.config.js        ← PM2 process definition
│
├── alertmanager/
│   └── alertmanager.yml               ← routing tree and receiver stubs
│
├── loki/
│   └── loki-config.yml                ← Loki server, schema, retention config
│
├── prometheus/
│   ├── prometheus.yml                 ← alternate scrape config (root-level copy)
│   └── alert_rules.yml
│
└── promtail/
    └── promtail-config.yml            ← log scrape jobs with pipeline parsing stages
```

> **Config duplication:** `monitoring/prometheus/` and `monitoring/3-tier-app/config/` contain similar files. The **authoritative** versions used by the setup scripts are those under `3-tier-app/config/`. The `prometheus/` copies are reference templates. The live configs are written directly to `/etc/prometheus/` by the setup scripts.

---

## 4. How the Pieces Fit Together

### Metrics flow

```
App Server exporters
  Node Exporter      :9100  ─┐
  PG Exporter        :9187  ─┤
  Nginx Exporter     :9113  ─┼──► Prometheus :9090 ──► Grafana :3001
  BMI App Exporter   :9091  ─┤         │
Monitoring-server            │         └──► AlertManager :9093
  Node Exporter      :9100  ─┤                    │
  Grafana            :3001  ─┤             notifications
  Loki               :3100  ─┤           (email/Slack — configure receivers)
  AlertManager       :9093  ─┘
  Prometheus         :9090  ─┘
```

- Prometheus scrapes every **15 seconds** (`scrape_interval`) and evaluates alert rules every **15 seconds** (`evaluation_interval`).
- Data retention: **30 days** in TSDB (`--storage.tsdb.retention.time=30d`).
- Hot reload is enabled (`--web.enable-lifecycle`): config changes apply without restart via `curl -X POST http://localhost:9090/-/reload`.

### Log flow

```
App Server log files
  /var/log/bmi-backend.log  ─┐
  /var/log/nginx/*access.log─┤
  /var/log/nginx/*error.log ─┤── Promtail :9080 ──► Loki :3100 ──► Grafana :3001
  /var/log/postgresql/*.log ─┤
  /var/log/syslog           ─┘
```

Promtail applies **pipeline stages** (regex extraction) to Nginx and PostgreSQL log lines, promoting fields like `method`, `status`, and `level` to Loki stream labels for efficient filtering.

### BMI App Exporter

The custom exporter (`exporters/bmi-app-exporter/exporter.js`) is a Node.js process that:

1. Opens a `pg` connection pool (max 5 connections) to PostgreSQL using `DATABASE_URL` from `backend/.env` (falling back to the individual `DB_*` variables when `DATABASE_URL` is unset).
2. Runs SQL queries against the `measurements` table every **15 seconds** to compute business KPIs.
3. Exposes results at `http://localhost:9091/metrics` in Prometheus text format via `prom-client`.

Exposed metrics:

| Metric | Type | Description |
|---|---|---|
| `bmi_measurements_total` | Gauge | Total rows in `measurements` table |
| `bmi_measurements_created_24h` | Gauge | Rows created in last 24 h |
| `bmi_measurements_created_1h` | Gauge | Rows created in last 1 h |
| `bmi_average_value` | Gauge | Mean BMI across all records |
| `bmi_category_count{category}` | Gauge | Count per BMI category label |
| `bmi_activity_level_count{activity_level}` | Gauge | Count per activity level label |
| `bmi_gender_count{sex}` | Gauge | Count per gender label |
| `bmi_database_size_bytes` | Gauge | Total `bmidb` size in bytes |
| `bmi_table_size_bytes` | Gauge | `measurements` table size |
| `bmi_average_age` | Gauge | Mean age across all records |
| `bmi_average_daily_calories` | Gauge | Mean daily calorie needs |
| `bmi_db_pool_total` | Gauge | PG connection pool: total slots |
| `bmi_db_pool_idle` | Gauge | PG connection pool: idle |
| `bmi_db_pool_waiting` | Gauge | PG connection pool: queued |
| `bmi_app_healthy` | Gauge | 1 = healthy, 0 = error on last collect |
| `bmi_metrics_collection_errors_total{error_type}` | Counter | Collection errors by type |
| `bmi_last_successful_collection_timestamp` | Gauge | Unix ms timestamp of last success |
| `bmi_app_*` (default) | various | Standard Node.js process metrics (CPU, heap, event loop) via `prom-client` default collection |

Additional endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /metrics` | Prometheus scrape endpoint |
| `GET /health` | Liveness check — queries `SELECT 1` to verify DB connectivity |
| `GET /status` | Verbose JSON: versions, pool stats, measurement count, last collection time |

---

## 5. Prerequisites

### Both servers

| Requirement | Details |
|---|---|
| OS | Ubuntu 22.04 LTS |
| Minimum specs | 2 vCPU, 4 GB RAM, 30 GB disk (monitoring server); 2 vCPU, 2 GB RAM (app server) |
| Access | Root or sudo |
| Internet | Required during setup for downloads |
| Network | Both VMs in the same VPC; can reach each other by **private IP** |

### Before running any monitoring setup

1. **BMI application must be deployed** on the app server. The monitoring stack only adds exporters on top of a running app — it does not deploy the application itself. Follow `IMPLEMENTATION_GUIDE.md` in the repo root first.

2. **Collect four values** — you will be prompted for them during setup:

   ```
   APP_SERVER_PUBLIC_IP    (ec2 public IPv4 of app server)
   APP_SERVER_PRIVATE_IP   (ec2 private IPv4 of app server — used in prometheus.yml)
   MONITORING_SERVER_PUBLIC_IP
   MONITORING_SERVER_PRIVATE_IP  (used in promtail-config.yml push URL)
   ```

3. **Security group rules** — configure before running setup:

   | Server | Port | Source | Service |
   |---|---|---|---|
   | App server | 9100 | Monitoring private IP | Node Exporter |
   | App server | 9187 | Monitoring private IP | PG Exporter |
   | App server | 9113 | Monitoring private IP | Nginx Exporter |
   | App server | 9091 | Monitoring private IP | BMI App Exporter |
   | Monitoring server | 3001 | Admin IP | Grafana |
   | Monitoring server | 9090 | Admin IP | Prometheus UI |
   | Monitoring server | 3100 | App server private IP | Loki ingestion |
   | Monitoring server | 22 | Admin IP | SSH |

   > Never open exporter ports (9100, 9187, 9113, 9091) to `0.0.0.0/0`. These endpoints have no authentication.

---

## 6. Deployment

Two paths are available for each server: automated (script) or manual (step-by-step guide). Both are fully idempotent — safe to re-run if a step fails.

### Automated path

**Step 1 — Monitoring Server** (run on Monitoring-ubuntu)

```bash
ssh -i your-key.pem ubuntu@MONITORING_SERVER_PUBLIC_IP

git clone https://github.com/sarowar-dev-ops/single-server-3tier-webapp-monitoring.git
cd single-server-3tier-webapp-monitoring

chmod +x monitoring/3-tier-app/scripts/setup-monitoring-server.sh
sudo ./monitoring/3-tier-app/scripts/setup-monitoring-server.sh
# Prompted once: enter APP_SERVER_PRIVATE_IP
```

Installs: Prometheus 2.48.0, Node Exporter 1.7.0, Grafana (latest), Loki 2.9.3, AlertManager 0.26.0.
Auto-provisions Grafana datasources (Prometheus + Loki) and all 5 dashboards.

**Step 2 — Application Server** (run on App-ubuntu)

```bash
ssh -i your-key.pem ubuntu@APP_SERVER_PUBLIC_IP

cd /home/ubuntu/single-server-3tier-webapp-monitoring

chmod +x monitoring/3-tier-app/scripts/setup-application-server.sh
sudo ./monitoring/3-tier-app/scripts/setup-application-server.sh
# Prompted once: enter MONITORING_SERVER_PRIVATE_IP
```

Installs: Node Exporter 1.7.0, postgres_exporter 0.15.0, nginx-prometheus-exporter 0.11.0, BMI App Exporter (PM2), Promtail 2.9.3.

### Manual path

For production environments where running unreviewed scripts is not acceptable:

- Monitoring server → [3-tier-app/scripts/setup-monitoring-server-guide.md](3-tier-app/scripts/setup-monitoring-server-guide.md)
- Application server → [3-tier-app/scripts/setup-application-server-guide.md](3-tier-app/scripts/setup-application-server-guide.md)

Each guide contains every command verbatim. No step requires opening the corresponding `.sh` file. An **"Automated Alternative"** section at the top of each guide explains how to use the script instead.

### Post-deployment verification

```bash
# On monitoring server — all 9 targets must be UP
curl -s http://localhost:9090/api/v1/targets \
  | python3 -c "
import json,sys
for t in json.load(sys.stdin)['data']['activeTargets']:
    print(t['labels']['job'], '->', t['health'])
"

# Expected output (9 lines, all 'up'):
# prometheus -> up
# node_exporter -> up
# postgresql -> up
# nginx -> up
# bmi-backend -> up
# node_exporter_monitoring -> up
# grafana -> up
# loki -> up
# alertmanager -> up
```

```bash
# Grafana should report both datasources healthy
curl -s http://admin:admin@localhost:3001/api/datasources \
  | python3 -m json.tool | grep '"name"'
# Expected: "Prometheus", "Loki"
```

Open Grafana at `http://MONITORING_SERVER_PUBLIC_IP:3001` (admin / admin — **change password on first login**).

---

## 7. Custom Application Exporter

The BMI App Exporter lives in `exporters/bmi-app-exporter/` and is the only component written as part of this project (all others are third-party binaries).

### Local development

```bash
cd monitoring/exporters/bmi-app-exporter
npm install

# Requires DATABASE_URL environment variable pointing at a running PostgreSQL instance
# If not set, it reads from backend/.env automatically
DATABASE_URL="postgresql://bmi_user:password@localhost:5432/bmidb" npm start
```

Verify locally:

```bash
curl http://localhost:9091/metrics   # Prometheus text output
curl http://localhost:9091/health    # {"status":"ok","database":"connected",...}
curl http://localhost:9091/status    # verbose JSON
```

### Production management (PM2)

```bash
# Status
pm2 status bmi-app-exporter

# Live logs
pm2 logs bmi-app-exporter

# Restart after a code change
pm2 restart bmi-app-exporter

# Tail error log only
tail -f monitoring/exporters/bmi-app-exporter/logs/err.log
```

### Environment variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `DATABASE_URL` | read from `backend/.env` | Yes* | PostgreSQL connection string |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | — | No | Fallback when `DATABASE_URL` is unset |
| `EXPORTER_PORT` | `9091` | No | HTTP port to serve metrics on |
| `NODE_ENV` | — | No | `production` disables dotenv auto-load |

### Adding a new metric

1. Declare a new `promClient.Gauge` or `promClient.Counter` in `exporter.js` after the existing metric declarations.
2. Add the query + `.set()` call inside `collectMetrics()`.
3. Restart: `pm2 restart bmi-app-exporter`.
4. Verify: `curl -s http://localhost:9091/metrics | grep your_metric_name`.
5. To alert on it: add a rule to `monitoring/3-tier-app/config/alert_rules.yml` and reload Prometheus (see [Introducing Changes Safely](#12-introducing-changes-safely)).

---

## 8. Dashboards

All dashboards are stored as JSON in `3-tier-app/dashboards/` and are provisioned automatically by Grafana on startup. They are loaded from `/var/lib/grafana/dashboards/` on the monitoring server.

| Dashboard | Description |
|---|---|
| **Three-Tier Application** | Overview panel: all 9 targets, per-tier health indicators |
| **BMI Business Metrics** | `bmi_measurements_total`, category distribution, average BMI, calorie averages |
| **Loki Logs** | Log stream viewer for all Promtail jobs: nginx-access, nginx-error, bmi-backend, postgresql, syslog |
| **Node.js Runtime** | Heap usage, event loop lag, GC pauses, active handles — from `bmi_app_` default metrics |
| **Monitoring Server Health** | CPU, memory, disk for the monitoring server itself |

### Reloading dashboards after a JSON change

```bash
# On monitoring server — no Grafana restart needed
curl -s -X POST http://admin:admin@localhost:3001/api/admin/provisioning/dashboards/reload
```

### Exporting a modified dashboard from Grafana UI

1. Open the dashboard → **⚙ Settings → JSON Model** → copy.
2. Replace the corresponding `.json` file in `3-tier-app/dashboards/`.
3. Commit. The next `setup-monitoring-server.sh` run or manual dashboard copy will pick it up.

---

## 9. Alert Rules Reference

Rules are defined in `3-tier-app/config/alert_rules.yml` (5 groups, evaluated every 30 s per group).

| Group | Alert | Severity | Condition | Duration |
|---|---|---|---|---|
| `system_alerts` | HighCPUUsage | warning | CPU > 80% | 5 m |
| `system_alerts` | CriticalCPUUsage | critical | CPU > 95% | 2 m |
| `system_alerts` | HighMemoryUsage | warning | Mem > 85% | 5 m |
| `system_alerts` | CriticalMemoryUsage | critical | Mem > 95% | 2 m |
| `system_alerts` | DiskSpaceLow | warning | Disk free < 20% | 5 m |
| `system_alerts` | DiskSpaceCritical | critical | Disk free < 10% | 2 m |
| `application_alerts` | BackendApplicationDown | critical | `up{job="bmi-backend"} == 0` | 2 m |
| `application_alerts` | BackendApplicationUnhealthy | critical | `bmi_app_healthy == 0` | 3 m |
| `application_alerts` | HighMetricsCollectionErrors | warning | errors/s > 0.5 | 5 m |
| `application_alerts` | NoRecentMeasurements | warning | no new rows in 1 h | 30 m |
| `database_alerts` | DatabaseDown | critical | `up{job="postgresql"} == 0` | 2 m |
| `database_alerts` | DatabaseConnectionsHigh | warning | connections > 80 | 5 m |
| `database_alerts` | DatabaseConnectionsCritical | critical | connections > 95 | 2 m |
| `database_alerts` | DatabaseDeadlocks | warning | deadlocks/s > 0 | 5 m |
| `database_alerts` | DatabaseHighRollbackRate | warning | rollbacks > 10% of commits | 10 m |
| `frontend_alerts` | NginxDown | critical | `up{job="nginx"} == 0` | 2 m |
| `frontend_alerts` | NginxHighConnectionRate | warning | > 100 connections/s | 5 m |
| `frontend_alerts` | NginxHighActiveConnections | warning | > 200 active connections | 10 m |
| `monitoring_alerts` | PrometheusTargetDown | warning | any `up == 0` | 5 m |
| `monitoring_alerts` | PrometheusConfigReloadFailed | critical | reload failed | 5 m |
| `monitoring_alerts` | PrometheusTSDBCompactionsFailing | warning | compaction errors | 10 m |
| `monitoring_alerts` | MonitoringServiceDown | critical | any monitoring service down | 2 m |

### AlertManager routing

AlertManager is configured with a tiered routing tree in `alertmanager/alertmanager.yml`:

- `critical` severity → `critical-alerts` receiver (group_wait 5 s, repeat 4 h)
- `warning` severity → `warning-alerts` receiver (group_wait 30 s, repeat 12 h)
- `category: database` → `database-team` receiver
- `category: infrastructure` → `infrastructure-team` receiver
- Fallback → `default-receiver`

**Receivers are stubs.** Before going to production, configure at least one. Example for email:

```yaml
# In alertmanager/alertmanager.yml → receivers section
- name: 'critical-alerts'
  email_configs:
    - to: 'oncall@yourcompany.com'
      from: 'alerts@yourcompany.com'
      smarthost: 'smtp.gmail.com:587'
      auth_username: 'alerts@yourcompany.com'
      auth_password: 'your-app-password'
      require_tls: true
```

After editing: `sudo systemctl reload alertmanager` or `amtool check-config /etc/alertmanager/alertmanager.yml`.

### Validate alert rules before deploying

```bash
# On monitoring server
promtool check rules /etc/prometheus/alert_rules.yml
```

---

## 10. Port Map and Network Policy

### App Server

| Port | Process | Inbound from |
|---|---|---|
| 80 | Nginx | Public internet |
| 3010 | BMI Node API | Nginx (localhost) |
| 5432 | PostgreSQL | localhost only |
| 9100 | Node Exporter | Monitoring server private IP |
| 9187 | PG Exporter | Monitoring server private IP |
| 9113 | Nginx Exporter | Monitoring server private IP |
| 9091 | BMI App Exporter | Monitoring server private IP |
| 9080 | Promtail | localhost only (push, outbound to monitoring) |

### Monitoring Server

| Port | Process | Inbound from |
|---|---|---|
| 3001 | Grafana | Admin IP |
| 9090 | Prometheus | Admin IP |
| 9093 | AlertManager | localhost only (Prometheus internal) |
| 3100 | Loki | App server private IP |
| 9100 | Node Exporter | localhost only (Prometheus internal) |
| 9096 | Loki gRPC | localhost only |

---

## 11. Day-2 Operations

### Service management

All components on the monitoring server run under **systemd**. The BMI App Exporter on the app server runs under **PM2**.

```bash
# Systemd services (on monitoring server)
sudo systemctl status prometheus grafana-server loki alertmanager node_exporter
sudo systemctl restart prometheus    # after config changes
sudo systemctl restart grafana-server

# Prometheus hot reload (no downtime)
curl -X POST http://localhost:9090/-/reload

# AlertManager hot reload (no downtime)
curl -X POST http://localhost:9093/-/reload

# PM2 (on app server)
pm2 status
pm2 restart bmi-app-exporter
pm2 logs bmi-app-exporter --lines 100
```

### Update a Prometheus scrape config

1. Edit `/etc/prometheus/prometheus.yml` on the monitoring server.
2. Validate: `promtool check config /etc/prometheus/prometheus.yml`
3. Hot-reload: `curl -X POST http://localhost:9090/-/reload`
4. Verify: `curl -s http://localhost:9090/api/v1/targets | python3 -m json.tool | grep '"health"'`

### Change the App Server IP (e.g. after EC2 redeployment)

```bash
# On monitoring server
sudo sed -i 's|OLD_APP_IP|NEW_APP_IP|g' /etc/prometheus/prometheus.yml
promtool check config /etc/prometheus/prometheus.yml
curl -X POST http://localhost:9090/-/reload
```

### Prometheus TSDB disk usage

```bash
# Current TSDB size
du -sh /var/lib/prometheus

# Check retention setting
grep retention /etc/systemd/system/prometheus.service

# Query head block stats via API
curl -s http://localhost:9090/api/v1/status/tsdb | python3 -m json.tool | head -20
```

Retention: 30 days. If disk is tight, reduce with: `--storage.tsdb.retention.time=15d` in the systemd unit.

### Loki disk usage

```bash
du -sh /var/lib/loki
ls -lh /var/lib/loki/chunks
```

Retention: 31 days, enforced by the compactor. Controlled by `limits_config.retention_period` in `loki/loki-config.yml`.

### Check live alerts

```bash
# Active alerts in Prometheus
curl -s http://localhost:9090/api/v1/alerts | python3 -m json.tool

# AlertManager — what is currently firing
curl -s http://localhost:9093/api/v2/alerts | python3 -m json.tool

# AlertManager — silence a noisy alert during maintenance
amtool silence add alertname=HighCPUUsage --duration=2h --comment="scheduled maintenance"
amtool silence query
```

### Backup / restore

The monitoring stack is **stateless from a configuration perspective** — all config is in this repository. Losing the monitoring server is recoverable by re-running the setup script on a fresh instance.

For metric history and dashboard state, periodically snapshot:

```bash
# Prometheus TSDB snapshot
curl -s -X POST http://localhost:9090/api/v1/admin/tsdb/snapshot
ls /var/lib/prometheus/snapshots/

# Grafana SQLite DB (stores alerts, API keys, preferences)
sudo cp /var/lib/grafana/grafana.db /tmp/grafana-backup-$(date +%Y%m%d).db
```

---

## 12. Introducing Changes Safely

### Config changes (alert rules, scrape config)

```bash
# 1. Edit the source file in the repo
# 2. Validate locally
promtool check config monitoring/3-tier-app/config/prometheus.yml
promtool check rules monitoring/3-tier-app/config/alert_rules.yml

# 3. Copy to live location on monitoring server
sudo cp monitoring/3-tier-app/config/prometheus.yml /etc/prometheus/prometheus.yml
sudo cp monitoring/3-tier-app/config/alert_rules.yml /etc/prometheus/alert_rules.yml
sudo chown prometheus:prometheus /etc/prometheus/prometheus.yml /etc/prometheus/alert_rules.yml

# 4. Hot-reload — zero downtime
curl -X POST http://localhost:9090/-/reload

# 5. Verify no targets went DOWN
curl -s http://localhost:9090/api/v1/targets | python3 -c "
import json,sys
down = [t['labels']['job'] for t in json.load(sys.stdin)['data']['activeTargets'] if t['health']!='up']
print('DOWN:', down if down else 'none')
"
```

### Exporter code changes (BMI App Exporter)

```bash
# 1. Test locally with a dev PostgreSQL instance
cd monitoring/exporters/bmi-app-exporter
npm install
DATABASE_URL="..." npm start
curl http://localhost:9091/health

# 2. Deploy to app server
git pull origin main
cd monitoring/exporters/bmi-app-exporter
npm install --production

# 3. Graceful restart via PM2
pm2 restart bmi-app-exporter

# 4. Confirm still healthy
curl http://localhost:9091/health
pm2 status bmi-app-exporter
```

### Dashboard changes

1. Edit in Grafana UI.
2. Export JSON: **Dashboard settings → JSON Model → copy**.
3. Replace `monitoring/3-tier-app/dashboards/<name>.json`.
4. Commit to git.
5. Reload live: `curl -X POST http://admin:admin@localhost:3001/api/admin/provisioning/dashboards/reload`

### Adding a new alert rule

1. Add the rule to `monitoring/3-tier-app/config/alert_rules.yml`.
2. Validate: `promtool check rules monitoring/3-tier-app/config/alert_rules.yml`
3. Copy to server and hot-reload (see above).
4. Check the rule appears: `curl -s http://localhost:9090/api/v1/rules | python3 -m json.tool | grep '"name"'`

### What NOT to do

- Do not edit `/etc/prometheus/prometheus.yml` directly on the server without also updating the repo — the next setup-script run will overwrite it.
- Do not restart Prometheus to reload config — use the `/-/reload` API. A restart causes a brief gap in scrape data.
- Do not increase `scrape_interval` below 10 s without raising the memory limit on the Prometheus process — each scrape target holds data proportional to interval.
- Do not open exporter ports to the internet to "test quickly" — once open they are public endpoints with no auth.

---

## 13. Troubleshooting

### Prometheus target shows DOWN

```bash
# Identify which target and why
curl -s http://localhost:9090/api/v1/targets | python3 -c "
import json,sys
for t in json.load(sys.stdin)['data']['activeTargets']:
    if t['health'] != 'up':
        print(t['labels']['job'], '|', t['scrapeUrl'], '|', t.get('lastError',''))
"

# Verify the app server IP in the config is correct
grep -E "[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" /etc/prometheus/prometheus.yml

# Test reachability from monitoring server
curl -s http://APP_SERVER_PRIVATE_IP:9100/metrics | head -3

# Check UFW on app server
sudo ufw status | grep -E "9100|9187|9113|9091"
```

### Grafana dashboards empty / no data

```bash
# 1. Check datasource health
curl -s http://admin:admin@localhost:3001/api/datasources/proxy/1/api/v1/query?query=up

# 2. Re-trigger dashboard provisioning reload
curl -X POST http://admin:admin@localhost:3001/api/admin/provisioning/dashboards/reload

# 3. Confirm JSON files are present
ls -la /var/lib/grafana/dashboards/

# 4. If missing, recopy
sudo cp /home/ubuntu/single-server-3tier-webapp-monitoring/monitoring/3-tier-app/dashboards/*.json \
  /var/lib/grafana/dashboards/
sudo chown grafana:grafana /var/lib/grafana/dashboards/*.json
```

### Loki shows no logs

```bash
# Check Loki is ready
curl http://localhost:3100/ready    # must return "ready"

# Check Promtail is running on app server
sudo systemctl status promtail

# Check Promtail can reach Loki (from app server)
curl -s -X POST http://MONITORING_SERVER_PRIVATE_IP:3100/loki/api/v1/push \
  -H "Content-Type: application/json" \
  -d '{"streams":[{"stream":{"test":"1"},"values":[["'$(date +%s)000000000'","test"]]}]}'
# Expected: HTTP 204 No Content

# Check firewall on monitoring server allows port 3100 from app server
sudo ufw status | grep 3100
```

### BMI App Exporter not collecting metrics

```bash
# On app server — check PM2 status
pm2 status bmi-app-exporter

# Check logs for SQL errors
pm2 logs bmi-app-exporter --lines 50

# Verify DATABASE_URL is set in backend/.env
grep DATABASE_URL /home/ubuntu/single-server-3tier-webapp-monitoring/backend/.env

# Test DB connection manually
curl http://localhost:9091/health
# Expected: {"status":"ok","database":"connected",...}

# Restart if stuck
pm2 restart bmi-app-exporter
```

### AlertManager not receiving alerts

```bash
# Verify Prometheus can reach AlertManager
grep -A 5 "alertmanagers:" /etc/prometheus/prometheus.yml

# AlertManager ready?
curl http://localhost:9093/-/ready

# View active alerts from Prometheus's perspective
curl -s http://localhost:9090/api/v1/alerts | python3 -m json.tool

# Validate AlertManager config
amtool check-config /etc/alertmanager/alertmanager.yml
```

### Check all monitoring services at once

```bash
for svc in prometheus grafana-server loki alertmanager node_exporter; do
  printf "%-25s %s\n" "$svc" "$(systemctl is-active $svc)"
done
```

---

## Author

*Md. Sarowar Alam*  
Lead DevOps Engineer, WPP Production - Dhaka  
Email: sarowar@hotmail.com  
LinkedIn: https://www.linkedin.com/in/sarowar/
