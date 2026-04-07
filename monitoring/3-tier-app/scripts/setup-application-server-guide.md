# Application Server Monitoring Setup Guide

Complete step-by-step manual guide to set up monitoring exporters on the BMI application server.  
Every command is self-contained — no scripts need to be run.

**Server:** BMI App Server (where the BMI application is deployed)  
**Run order:** Complete this AFTER the Monitoring Server setup is done.

---

## Prerequisites

| Requirement | Details |
|---|---|
| OS | Ubuntu 22.04 LTS |
| Access | Root or sudo |
| Internet | Required for downloads |
| BMI App | Must already be deployed (follow `IMPLEMENTATION_GUIDE.md` first) |
| Versions installed | Node Exporter 1.7.0, PostgreSQL Exporter 0.15.0, Nginx Exporter 0.11.0, Promtail 2.9.3 |

**You will be prompted once at the start for:**
- Monitoring Server Private IP address

---

## Automated Alternative

If you prefer automation over manual steps, the script `setup-application-server.sh` performs every command in this guide in order. To run it instead:

```bash
# SSH to your app server
ssh -i your-key.pem ubuntu@APP_SERVER_IP

# Navigate to project directory
cd /home/ubuntu/single-server-3tier-webapp-monitoring

# Make executable and run
chmod +x monitoring/3-tier-app/scripts/setup-application-server.sh
sudo ./monitoring/3-tier-app/scripts/setup-application-server.sh
```

To follow this guide manually instead, continue from Step 1 below.

---

## Step 1 — Initial System Setup

**What this step does:**
- Detects the server's public and private IP via EC2 IMDSv2 metadata
- Prompts you to enter the Monitoring Server Private IP
- Runs `apt update && apt upgrade`
- Installs: `wget curl git unzip tar jq net-tools`

**Commands:**
```bash
# Update and upgrade system packages
sudo apt update -qq
sudo DEBIAN_FRONTEND=noninteractive apt upgrade -y -qq

# Install essential tools
sudo DEBIAN_FRONTEND=noninteractive apt install -y \
    wget curl git unzip tar jq net-tools
```

**You will be prompted:**
```
Enter your Monitoring Server Private IP address:
Monitoring Server Private IP: <type it here>
```

> Set this as `MONITORING_SERVER_IP` in all command blocks below that reference it (Steps 2, 5, and 7).

**Verify after step:**
```bash
# Confirm essential tools are available
which wget curl jq net-tools
# Confirm this server's IPs
hostname -I
```

✅ **Expected:** Both IPs visible — your app server public IP and the monitoring server private IP you entered

---

## Dependency Checks (Auto-installed if missing)

The following tools must be present before installing exporters. Install any that are missing:

### PostgreSQL
- Verifies `psql` is available and `postgresql` service is running
- If missing: installs `postgresql postgresql-contrib` and starts the service

**Install commands (only if not already installed):**
```bash
sudo DEBIAN_FRONTEND=noninteractive apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

**Verify:**
```bash
sudo systemctl status postgresql
psql --version
```
✅ **Expected:** `Active: active (running)`, version output shown

### Nginx
- Verifies `nginx` is available and running
- If missing: installs and starts Nginx

**Install commands (only if not already installed):**
```bash
sudo DEBIAN_FRONTEND=noninteractive apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

**Verify:**
```bash
sudo systemctl status nginx
nginx -v
```
✅ **Expected:** `Active: active (running)`

### Node.js (v20.x LTS)
- Checks if `node` is in PATH
- If missing: installs via NodeSource setup script

**Install commands (only if not already installed):**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
```

**Verify:**
```bash
node --version    # Should show v20.x.x
npm --version
```
✅ **Expected:** `v20.x.x`

### PM2
- Checks if `pm2` is in PATH
- If missing: runs `npm install -g pm2`

**Install commands (only if not already installed):**
```bash
sudo npm install -g pm2
```

**Verify:**
```bash
pm2 --version
```
✅ **Expected:** Version number printed

---

## Step 2 — Configure Firewall

**What this step does:**
- Opens 4 exporter ports, but **only from the monitoring server's IP** (not from anywhere):

| Port | Exporter | Rule |
|---|---|---|
| 9100 | Node Exporter | Allow from MONITORING_SERVER_IP |
| 9187 | PostgreSQL Exporter | Allow from MONITORING_SERVER_IP |
| 9113 | Nginx Exporter | Allow from MONITORING_SERVER_IP |
| 9091 | BMI App Exporter | Allow from MONITORING_SERVER_IP |

**Commands:**
```bash
MONITORING_SERVER_IP="<your-monitoring-server-private-ip>"

# Allow each exporter port only from the monitoring server (not from anywhere)
sudo ufw allow from "$MONITORING_SERVER_IP" to any port 9100 proto tcp comment 'Node Exporter'
sudo ufw allow from "$MONITORING_SERVER_IP" to any port 9187 proto tcp comment 'PostgreSQL Exporter'
sudo ufw allow from "$MONITORING_SERVER_IP" to any port 9113 proto tcp comment 'Nginx Exporter'
sudo ufw allow from "$MONITORING_SERVER_IP" to any port 9091 proto tcp comment 'BMI App Exporter'

sudo ufw reload
```

**Verify after step:**
```bash
sudo ufw status | grep -E "9100|9187|9113|9091"
```
✅ **Expected:** 4 lines showing `ALLOW` with your monitoring server's IP as source

---

## Step 3 — Install Node Exporter (v1.7.0)

**What this step does:**
- Creates `node_exporter` system user (no shell, no home)
- Downloads Node Exporter binary from GitHub
- Installs to `/usr/local/bin/node_exporter`
- Creates systemd service
- Starts and enables the service

**Commands:**
```bash
# Create system user
sudo useradd --no-create-home --shell /bin/false node_exporter

# Download and extract
cd /tmp
wget https://github.com/prometheus/node_exporter/releases/download/v1.7.0/node_exporter-1.7.0.linux-amd64.tar.gz
tar -xf node_exporter-1.7.0.linux-amd64.tar.gz

# Install binary
sudo cp -f node_exporter-1.7.0.linux-amd64/node_exporter /usr/local/bin/
sudo chown node_exporter:node_exporter /usr/local/bin/node_exporter

# Clean up
rm -rf node_exporter-1.7.0.linux-amd64*

# Create systemd service
sudo tee /etc/systemd/system/node_exporter.service > /dev/null <<'EOF'
[Unit]
Description=Node Exporter
After=network.target

[Service]
User=node_exporter
Group=node_exporter
Type=simple
ExecStart=/usr/local/bin/node_exporter

[Install]
WantedBy=multi-user.target
EOF

# Start and enable
sudo systemctl daemon-reload
sudo systemctl enable node_exporter
sudo systemctl start node_exporter
```

**Verify after step:**
```bash
# Service status
sudo systemctl status node_exporter

# Metrics endpoint responding
curl -s http://localhost:9100/metrics | head -5

# Check a specific metric
curl -s http://localhost:9100/metrics | grep node_cpu_seconds_total | head -3
```
✅ **Expected:** Service `active (running)`, metrics output with `# HELP` and `# TYPE` lines

---

## Step 4 — Install PostgreSQL Exporter (v0.15.0)

**What this step does:**
- Downloads PostgreSQL Exporter binary from GitHub
- Creates `postgres_exporter` system user
- Creates a dedicated PostgreSQL monitoring user in the `bmidb` database with read-only permissions
- Generates a random password for the monitoring user
- Writes connection string to `/etc/default/postgres_exporter` (mode 600)
- Creates systemd service using `EnvironmentFile`
- Starts and enables the service

**Created PostgreSQL user permissions:**
- `CONNECT` on `bmidb`
- `USAGE` on `public` schema
- `SELECT` on all tables
- `pg_monitor` role (for system catalog access)

**Commands:**
```bash
# Download and extract
cd /tmp
wget https://github.com/prometheus-community/postgres_exporter/releases/download/v0.15.0/postgres_exporter-0.15.0.linux-amd64.tar.gz
tar -xf postgres_exporter-0.15.0.linux-amd64.tar.gz

# Install binary
sudo cp -f postgres_exporter-0.15.0.linux-amd64/postgres_exporter /usr/local/bin/
sudo chmod +x /usr/local/bin/postgres_exporter

# Clean up
rm -rf postgres_exporter-0.15.0.linux-amd64*

# Create system user
sudo useradd --no-create-home --shell /bin/false postgres_exporter

# Create PostgreSQL monitoring user and grant permissions
# Generate a random password for the PostgreSQL monitoring user (or set your own)
PG_EXPORTER_PASSWORD=$(openssl rand -base64 24 | tr -d "=+/" | cut -c1-20)

sudo -u postgres psql -d bmidb <<EOF
DO \$\$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_user WHERE usename = 'postgres_exporter') THEN
      CREATE USER postgres_exporter WITH PASSWORD '$PG_EXPORTER_PASSWORD';
   END IF;
END
\$\$;
ALTER USER postgres_exporter SET SEARCH_PATH TO postgres_exporter,pg_catalog;
GRANT CONNECT ON DATABASE bmidb TO postgres_exporter;
GRANT USAGE ON SCHEMA public TO postgres_exporter;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO postgres_exporter;
GRANT pg_monitor TO postgres_exporter;
EOF

# Write connection string to environment file (mode 600 — credentials protected)
sudo tee /etc/default/postgres_exporter > /dev/null <<EOF
DATA_SOURCE_NAME="postgresql://postgres_exporter:${PG_EXPORTER_PASSWORD}@localhost:5432/bmidb?sslmode=disable"
EOF
sudo chown postgres_exporter:postgres_exporter /etc/default/postgres_exporter
sudo chmod 600 /etc/default/postgres_exporter

# Create systemd service
sudo tee /etc/systemd/system/postgres_exporter.service > /dev/null <<'EOF'
[Unit]
Description=PostgreSQL Exporter
After=network.target

[Service]
Type=simple
User=postgres_exporter
Group=postgres_exporter
EnvironmentFile=/etc/default/postgres_exporter
ExecStart=/usr/local/bin/postgres_exporter
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Start and enable
sudo systemctl daemon-reload
sudo systemctl enable postgres_exporter
sudo systemctl start postgres_exporter
```

**Verify after step:**
```bash
# Service status
sudo systemctl status postgres_exporter

# Metrics endpoint responding
curl -s http://localhost:9187/metrics | grep "^pg_" | head -10

# Verify monitoring user exists in database
sudo -u postgres psql -c "\du postgres_exporter"
```
✅ **Expected:** Service `active (running)`, `pg_` prefixed metrics visible

---

## Step 5 — Install Nginx Exporter (v0.11.0)

**What this step does:**
- Finds the Nginx config for the BMI app (`/etc/nginx/sites-available/bmi-health-tracker`)
- Adds a `/nginx_status` location block with `stub_status on` (if not already present)
  - Access restricted to `127.0.0.1` and the monitoring server IP
  - Original config backed up with timestamp
- Reloads Nginx to apply changes
- Downloads Nginx Exporter binary
- Installs to `/usr/local/bin/nginx-prometheus-exporter`
- Creates `nginx_exporter` system user
- Creates systemd service pointing at `http://localhost/nginx_status`
- Starts and enables the service

**Commands:**
```bash
MONITORING_SERVER_IP="<your-monitoring-server-private-ip>"

# --- Configure Nginx stub_status ---
NGINX_CONFIG="/etc/nginx/sites-available/bmi-health-tracker"
# Fall back to default if bmi-health-tracker config doesn't exist
[ -f "$NGINX_CONFIG" ] || NGINX_CONFIG="/etc/nginx/sites-available/default"

# Backup the config
sudo cp "$NGINX_CONFIG" "${NGINX_CONFIG}.backup.$(date +%Y%m%d_%H%M%S)"

# Add stub_status block (if not already present)
if ! grep -q "stub_status" "$NGINX_CONFIG"; then
  sudo sed -i '/^}$/i \    # Nginx status endpoint for monitoring\n    location /nginx_status {\n        stub_status on;\n        access_log off;\n        allow 127.0.0.1;\n        allow '"$MONITORING_SERVER_IP"';\n        deny all;\n    }\n' "$NGINX_CONFIG"
fi

# Test config and reload Nginx
sudo nginx -t
sudo systemctl reload nginx

# --- Install Nginx Exporter ---
cd /tmp
wget https://github.com/nginxinc/nginx-prometheus-exporter/releases/download/v0.11.0/nginx-prometheus-exporter_0.11.0_linux_amd64.tar.gz
tar -xf nginx-prometheus-exporter_0.11.0_linux_amd64.tar.gz

sudo mv -f nginx-prometheus-exporter /usr/local/bin/
sudo chmod +x /usr/local/bin/nginx-prometheus-exporter
rm -f nginx-prometheus-exporter_0.11.0_linux_amd64.tar.gz

# Create system user
sudo useradd --no-create-home --shell /bin/false nginx_exporter

# Create systemd service
sudo tee /etc/systemd/system/nginx_exporter.service > /dev/null <<'EOF'
[Unit]
Description=Nginx Prometheus Exporter
After=network.target

[Service]
Type=simple
User=nginx_exporter
Group=nginx_exporter
ExecStart=/usr/local/bin/nginx-prometheus-exporter \
  -nginx.scrape-uri=http://localhost/nginx_status
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Start and enable
sudo systemctl daemon-reload
sudo systemctl enable nginx_exporter
sudo systemctl start nginx_exporter
```

**Verify after step:**
```bash
# Service status
sudo systemctl status nginx_exporter

# Stub status endpoint (used by exporter internally)
curl -s http://localhost/nginx_status

# Exporter metrics endpoint
curl -s http://localhost:9113/metrics | grep "^nginx_" | head -10
```
✅ **Expected:** `nginx_status` shows active connections, `nginx_connections_active` metric visible

---

## Step 6 — Install BMI Custom Application Exporter

**What this step does:**
- Verifies `monitoring/exporters/bmi-app-exporter/exporter.js` exists
- Fixes directory ownership to the original (non-root) user
- Runs `npm install` in the exporter directory as the original user
- Verifies/creates `backend/.env` with `EXPORTER_PORT=9091`
- Creates `/var/log/pm2/` and `exporter/logs/` directories
- Starts the exporter via PM2 as the original user:
  - Name: `bmi-app-exporter`
  - Reads `DATABASE_URL` from `backend/.env`
  - Logs to `monitoring/exporters/bmi-app-exporter/logs/`
- Runs `pm2 save` to persist the process list
- Configures `pm2 startup` systemd integration for boot persistence

**Commands:**
```bash
# Replace with your actual username (e.g. ubuntu)
ORIGINAL_USER="ubuntu"
PROJECT_ROOT="/home/$ORIGINAL_USER/single-server-3tier-webapp-monitoring"
EXPORTER_DIR="$PROJECT_ROOT/monitoring/exporters/bmi-app-exporter"
BACKEND_DIR="$PROJECT_ROOT/backend"

# Fix ownership so npm install can write node_modules
sudo chown -R "$ORIGINAL_USER:$ORIGINAL_USER" "$EXPORTER_DIR"
sudo chown -R "$ORIGINAL_USER:$ORIGINAL_USER" "$BACKEND_DIR"

# Install exporter dependencies
cd "$EXPORTER_DIR"
sudo -u "$ORIGINAL_USER" npm install

# Ensure EXPORTER_PORT is in backend/.env
grep -q "EXPORTER_PORT" "$BACKEND_DIR/.env" || \
  echo -e "\n# Exporter Configuration\nEXPORTER_PORT=9091" | sudo tee -a "$BACKEND_DIR/.env" > /dev/null

# Create log directories
sudo mkdir -p /var/log/pm2 "$EXPORTER_DIR/logs"
sudo chown -R "$ORIGINAL_USER:$ORIGINAL_USER" /var/log/pm2 "$EXPORTER_DIR/logs"

# Remove any stale PM2 process (idempotent)
sudo -u "$ORIGINAL_USER" -H bash -c "pm2 delete bmi-app-exporter" 2>/dev/null || true

# Start exporter via PM2 as the non-root user
sudo -u "$ORIGINAL_USER" -H bash <<EOF
export HOME=/home/$ORIGINAL_USER
export USER=$ORIGINAL_USER
cd "$EXPORTER_DIR"
pm2 start "$EXPORTER_DIR/exporter.js" \
    --name bmi-app-exporter \
    --cwd "$EXPORTER_DIR" \
    --error "$EXPORTER_DIR/logs/err.log" \
    --output "$EXPORTER_DIR/logs/out.log" \
    --time \
    --env production
pm2 save
EOF

# Configure PM2 to auto-start on server reboot
sudo -u "$ORIGINAL_USER" -H bash -c "pm2 startup systemd -u $ORIGINAL_USER --hp /home/$ORIGINAL_USER" \
  | grep "sudo" | bash
```

**Verify after step:**
```bash
# PM2 status (run as ubuntu user, not root)
pm2 list

# Exporter metrics
curl -s http://localhost:9091/metrics | grep "^bmi_" | head -20

# Key BMI metrics to confirm
curl -s http://localhost:9091/metrics | grep -E "bmi_measurements_total|bmi_app_healthy|bmi_average_value"

# Check logs if something is wrong
pm2 logs bmi-app-exporter --lines 50
```
✅ **Expected:** `bmi-app-exporter` shows `online` in PM2 list, all `bmi_` metrics visible

---

## Step 7 — Install Promtail (v2.9.3)

**What this step does:**
- Downloads Promtail binary from GitHub
- Installs to `/usr/local/bin/promtail`
- Creates `promtail` system user
- Adds `promtail` to `adm` and `systemd-journal` groups (required for log access)
- Creates `/etc/promtail/promtail-config.yml` with 5 log scrape jobs:

| Job | Source Path | Labels |
|---|---|---|
| `varlogs` | `/var/log/*.log` | `server: bmi-app-server` |
| `nginx-access` | `/var/log/nginx/*access.log` | `tier: frontend` |
| `nginx-error` | `/var/log/nginx/*error.log` | `tier: frontend` |
| `postgresql` | `/var/log/postgresql/*.log` | `tier: database` |
| `bmi-backend` | `/var/log/bmi-backend.log` | `tier: backend` |

- Ships logs to `http://MONITORING_SERVER_IP:3100/loki/api/v1/push`
- Creates systemd service, starts and enables it

**Commands:**
```bash
MONITORING_SERVER_IP="<your-monitoring-server-private-ip>"

# Download and install Promtail binary
cd /tmp
wget https://github.com/grafana/loki/releases/download/v2.9.3/promtail-linux-amd64.zip
unzip -o promtail-linux-amd64.zip
sudo mv -f promtail-linux-amd64 /usr/local/bin/promtail
sudo chmod +x /usr/local/bin/promtail
rm -f promtail-linux-amd64.zip

# Create system user and directories
sudo useradd --no-create-home --shell /bin/false promtail
sudo mkdir -p /etc/promtail /var/lib/promtail
sudo chown promtail:promtail /var/lib/promtail

# Add promtail to log-reading groups
sudo usermod -aG adm promtail
sudo usermod -aG systemd-journal promtail

# Write Promtail configuration
sudo tee /etc/promtail/promtail-config.yml > /dev/null <<EOF
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /var/lib/promtail/positions.yaml

clients:
  - url: http://${MONITORING_SERVER_IP}:3100/loki/api/v1/push

scrape_configs:
  - job_name: system
    static_configs:
      - targets:
          - localhost
        labels:
          job: varlogs
          server: bmi-app-server
          __path__: /var/log/*.log

  - job_name: nginx-access
    static_configs:
      - targets:
          - localhost
        labels:
          job: nginx-access
          server: bmi-app-server
          tier: frontend
          __path__: /var/log/nginx/*access.log

  - job_name: nginx-error
    static_configs:
      - targets:
          - localhost
        labels:
          job: nginx-error
          server: bmi-app-server
          tier: frontend
          __path__: /var/log/nginx/*error.log

  - job_name: postgresql
    static_configs:
      - targets:
          - localhost
        labels:
          job: postgresql
          server: bmi-app-server
          tier: database
          __path__: /var/log/postgresql/*.log

  - job_name: bmi-backend
    static_configs:
      - targets:
          - localhost
        labels:
          job: bmi-backend
          server: bmi-app-server
          tier: backend
          __path__: /var/log/bmi-backend.log
EOF

sudo chown promtail:promtail /etc/promtail/promtail-config.yml

# Create systemd service
sudo tee /etc/systemd/system/promtail.service > /dev/null <<'EOF'
[Unit]
Description=Promtail Log Shipper
After=network.target

[Service]
Type=simple
User=promtail
Group=promtail
ExecStart=/usr/local/bin/promtail -config.file=/etc/promtail/promtail-config.yml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Start and enable
sudo systemctl daemon-reload
sudo systemctl enable promtail
sudo systemctl start promtail
```

**Verify after step:**
```bash
# Service status
sudo systemctl status promtail

# Promtail ready endpoint
curl -s http://localhost:9080/ready

# Check Promtail is connecting to Loki (check logs)
sudo journalctl -u promtail -n 30

# Verify config has correct monitoring server IP
grep "url:" /etc/promtail/promtail-config.yml
```
✅ **Expected:** `ready` response, no connection errors in journal, correct Loki URL shown

---

## Step 8 — Final Verification

**What this step does:**
- Tests each exporter's HTTP endpoint with `curl`
- Checks each systemd service is `active`
- Checks PM2 shows `bmi-app-exporter` as `online`
- Exits with error if anything is not running

**All checks performed:**

| Component | Check Method | Port |
|---|---|---|
| node_exporter | `curl /metrics` | 9100 |
| postgres_exporter | `curl /metrics` | 9187 |
| nginx_exporter | `curl /metrics` | 9113 |
| bmi-app-exporter | `curl /metrics` | 9091 |
| promtail | `curl /ready` | 9080 |
| node_exporter | `systemctl is-active` | — |
| postgres_exporter | `systemctl is-active` | — |
| nginx_exporter | `systemctl is-active` | — |
| bmi-backend | `systemctl is-active` | — |
| promtail | `systemctl is-active` | — |
| bmi-app-exporter | `pm2 list \| grep online` | — |

**Run all checks manually:**
```bash
for port in 9100 9187 9113 9091; do
  echo -n "Port $port: "
  curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/metrics
  echo ""
done

echo -n "Promtail: "
curl -s http://localhost:9080/ready

for svc in node_exporter postgres_exporter nginx_exporter bmi-backend promtail; do
  echo "$svc: $(systemctl is-active $svc)"
done

# PM2 check — run as the non-root user (e.g. ubuntu)
sudo -u ubuntu pm2 list | grep bmi-app-exporter
```
✅ **Expected:** All ports return `200`, all services `active`, PM2 shows `online`

---

## What Gets Installed — Summary

| Component | Binary | Config | Port | Manager |
|---|---|---|---|---|
| Node Exporter | `/usr/local/bin/node_exporter` | none | 9100 | systemd |
| PostgreSQL Exporter | `/usr/local/bin/postgres_exporter` | `/etc/default/postgres_exporter` | 9187 | systemd |
| Nginx Exporter | `/usr/local/bin/nginx-prometheus-exporter` | `/etc/nginx/sites-available/bmi-health-tracker` | 9113 | systemd |
| BMI App Exporter | `monitoring/exporters/bmi-app-exporter/` | `backend/.env` | 9091 | PM2 |
| Promtail | `/usr/local/bin/promtail` | `/etc/promtail/promtail-config.yml` | 9080 | systemd |
| BMI Backend | `backend/src/server.js` | `backend/.env` | 3010 | systemd |

---

## Troubleshooting

**PostgreSQL Exporter fails to connect:**
```bash
# Check environment file
sudo cat /etc/default/postgres_exporter

# Test connection manually
psql "$(sudo cat /etc/default/postgres_exporter | cut -d= -f2-)" -c "SELECT 1;"

# Check postgres_exporter user exists
sudo -u postgres psql -c "\du postgres_exporter"
```

**BMI App Exporter not starting:**
```bash
# Check logs
pm2 logs bmi-app-exporter --lines 100

# Verify .env has correct DATABASE_URL
cat /home/ubuntu/single-server-3tier-webapp-monitoring/backend/.env

# Test database connection manually
node -e "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query('SELECT 1').then(()=>console.log('OK')).catch(console.error)"
```

**Nginx Exporter fails:**
```bash
# Check stub_status is accessible
curl http://localhost/nginx_status

# If 403 or 404, check Nginx config
cat /etc/nginx/sites-available/bmi-health-tracker | grep -A 8 nginx_status

# Reload Nginx after any config change
sudo nginx -t && sudo systemctl reload nginx
```

**Promtail not shipping logs:**
```bash
# Check connectivity to Loki
curl -s http://MONITORING_SERVER_IP:3100/ready

# Confirm promtail config has correct IP
grep url /etc/promtail/promtail-config.yml

# Live log view
sudo journalctl -u promtail -f
```

---

## Next Step

Once all steps are complete, go to the **Monitoring Server** and verify all targets are UP:

```
http://MONITORING_SERVER_IP:9090/targets
```

All 9 scrape targets should show **State: UP**:
- `prometheus`, `node_exporter_monitoring`, `grafana`, `loki`, `alertmanager` (on monitoring server)
- `node_exporter`, `postgresql`, `nginx`, `bmi-backend` (on app server)

---

## 🧑‍💻 Author
*Md. Sarowar Alam*  
Lead DevOps Engineer, WPP Production - Dhaka  
📧 Email: sarowar@hotmail.com  
🔗 LinkedIn: https://www.linkedin.com/in/sarowar/

---
