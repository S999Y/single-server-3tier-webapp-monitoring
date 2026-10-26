# `setup-database.sh` — Explanation

## Overview

`setup-database.sh` is a fully automated PostgreSQL setup script for the
**BMI Health Tracker** application. It is intended to be run **as root** on a
Debian/Ubuntu server:

```bash
sudo ./setup-database.sh
```

It handles everything needed to go from a bare server to a working database:
installing PostgreSQL, configuring the service, creating the user/database,
running migrations, generating config files, and creating backup/restore tools.

> The script uses `set -e`, so it **exits immediately if any command fails**.

---

## Configuration Constants

Defined near the top of the script (lines 28–34):

| Variable      | Value        | Meaning                                  |
|---------------|--------------|------------------------------------------|
| `DB_USER`     | `bmi_user`   | PostgreSQL role/user name                |
| `DB_NAME`     | `bmidb`      | Database name                            |
| `DB_VERSION`  | `14`         | PostgreSQL major version to install      |
| `SCRIPT_DIR`  | (computed)   | Directory containing this script         |
| `PROJECT_ROOT`| (computed)   | Parent of `SCRIPT_DIR` (repo root)       |

---

## Helper Functions

| Function | Purpose |
|----------|---------|
| `print_header` | Prints a blue section banner |
| `print_success` | Green `[SUCCESS]` message |
| `print_error` | Red `[ERROR]` message |
| `print_warning` | Yellow `[WARNING]` message |
| `print_info` | Blue `[INFO]` message |
| `check_root` | Aborts unless run with `sudo`/root (checks `$EUID`) |

---

## Step-by-Step Workflow

The `main()` function (line 620) drives the whole process:

### 0. Confirmation
Prompts `Continue? (y/n)` before doing anything.

### 1. `check_postgresql_installed` (line 75)
Uses `command -v psql` to detect an existing install and extracts the major
version from `psql --version`.

### 2. `install_postgresql` (line 88)
If not installed, runs `apt update` and installs
`postgresql-14` + `postgresql-contrib-14`.

### 3. `start_postgresql_service` (line 104)
- `systemctl start postgresql`
- `systemctl enable postgresql` (starts on boot)
- Verifies it is active, otherwise prints status and exits.

### 4. `configure_postgresql` (line 203)
- Locates `postgresql.conf` and `pg_hba.conf` via `SHOW config_file` / `SHOW hba_file`.
- Backs both up with a timestamp suffix.
- Appends authentication rules to `pg_hba.conf` allowing the user to connect
  to `bmidb` via `md5` (password) over local socket, `127.0.0.1`, and `::1`.
- Appends performance tuning settings to `postgresql.conf`
  (e.g. `max_connections`, `shared_buffers = 256MB`, `effective_cache_size = 1GB`,
  WAL sizes, etc.) — tuned for a small app.
- Both blocks are guarded so they are only added once (idempotent).
- Reloads PostgreSQL with `systemctl reload postgresql`.

### 5. `create_database_user` (line 129)
- Checks `pg_roles`; if `bmi_user` exists, asks whether to drop and recreate.
- Prompts for the password twice (hidden input) until they match.
- Exports it as `DB_PASSWORD` for later steps.
- Runs `CREATE USER bmi_user WITH PASSWORD '...'`.

### 6. `create_database` (line 168)
- Detects an existing `bmidb` and offers to drop it (**data loss warning**),
  terminating active connections first.
- Creates the DB: `CREATE DATABASE bmidb OWNER bmi_user`.
- Grants privileges on the database, the `public` schema, and sets default
  privileges for future tables and sequences.

### 7. `run_migrations` (line 260)
- Reads SQL files from `$PROJECT_ROOT/backend/migrations/*.sql`, sorted.
- If the directory or files are missing, it warns and skips.
- Sets `PGPASSWORD` and applies each file with `psql -f`.
- Stops immediately if any migration fails.
- Clears `PGPASSWORD` afterwards.

### 8. `seed_sample_data` (line 306)
- Optional prompt. If accepted, inserts 10 sample rows into the
  `measurements` table (weight, height, age, sex, activity level, BMI/BMR/
  calories, staggered measurement dates and timestamps) and prints the total
  row count.

### 9. `test_connection` (line 347)
- Verifies login with `SELECT version()`.
- Lists tables (`\dt`) and counts tables in the `public` schema.

### 10. `generate_env_file` (line 375)
Creates two files in `backend/`:
- **`.env`** — real credentials (`DATABASE_URL` plus DB host/port/name/user/
  password), `PORT=3010`, `NODE_ENV=production`, and
  `FRONTEND_URL=http://localhost`. Permissions set to `600`.
- **`.env.example`** — same layout with placeholder values. Permissions `644`.

These match the variables the backend actually reads
(`DATABASE_URL`, `PORT`, `NODE_ENV`, `FRONTEND_URL`).

Warns that `.env` contains secrets and must be in `.gitignore`.

### 11. `create_backup_script` (line 443)
Generates `database/backup-database.sh`, which:
- Dumps `bmidb` with `pg_dump` to `~/bmi_backups/bmidb_<timestamp>.sql`
- Gzips it
- Keeps only the **last 7** backups.

### 12. `create_restore_script` (line 497)
Generates `database/restore-database.sh`, which:
- Requires a `.sql.gz` argument (lists available backups otherwise)
- Decompresses it
- Terminates existing connections to the DB
- Restores via `psql < file`

### 13. `display_summary` (line 563)
Prints connection details, the connection string, the `.env` location,
useful commands (connect, status, logs, backup, restore), and security reminders.

---

## Side Effects Summary

Typical run will:

1. Install system packages (if PostgreSQL missing).
2. Enable and start the `postgresql` service.
3. **Modify** `postgresql.conf` and `pg_hba.conf` (originals are backed up).
4. Create/modify the `bmi_user` role and `bmidb` database (**possibly dropping
   existing ones after confirmation**).
5. Apply all migrations and optionally insert sample data.
6. Write `backend/.env` and `backend/.env.example`.
7. Generate executable `backup-database.sh` and `restore-database.sh`.

---

## Prerequisites

- Debian/Ubuntu (uses `apt` and `systemctl`)
- Root/sudo privileges
- Migrations present at `backend/migrations/*.sql` (optional but recommended)

---

## Notes & Caveats

- **Assumes Debian-family Linux**; `apt` is hard-coded, so it won't work on
  RHEL/Fedora, macOS, or Windows directly.
- **Interactive only** — it prompts for passwords and confirmations, so it is
  not suited for unattended/CI use without modification.
- The password is interpolated directly into SQL (`CREATE USER ... PASSWORD
  '...'`); a quote character in the password would break the statement.
- Hard-coded tuning values target a small single-server deployment.
- Re-running is mostly safe, but it will ask before dropping the user/database.
