#!/bin/sh
set -eu

set -- postgres \
  -c "max_connections=${POSTGRES_MAX_CONNECTIONS:?set POSTGRES_MAX_CONNECTIONS in .env}" \
  -c "superuser_reserved_connections=${POSTGRES_SUPERUSER_RESERVED_CONNECTIONS:?set POSTGRES_SUPERUSER_RESERVED_CONNECTIONS in .env}" \
  -c "shared_buffers=${POSTGRES_SHARED_BUFFERS:?set POSTGRES_SHARED_BUFFERS in .env}" \
  -c "effective_cache_size=${POSTGRES_EFFECTIVE_CACHE_SIZE:?set POSTGRES_EFFECTIVE_CACHE_SIZE in .env}" \
  -c "work_mem=${POSTGRES_WORK_MEM:?set POSTGRES_WORK_MEM in .env}" \
  -c "maintenance_work_mem=${POSTGRES_MAINTENANCE_WORK_MEM:?set POSTGRES_MAINTENANCE_WORK_MEM in .env}" \
  -c "checkpoint_timeout=${POSTGRES_CHECKPOINT_TIMEOUT:?set POSTGRES_CHECKPOINT_TIMEOUT in .env}" \
  -c "checkpoint_completion_target=${POSTGRES_CHECKPOINT_COMPLETION_TARGET:?set POSTGRES_CHECKPOINT_COMPLETION_TARGET in .env}" \
  -c "max_wal_size=${POSTGRES_MAX_WAL_SIZE:?set POSTGRES_MAX_WAL_SIZE in .env}" \
  -c "min_wal_size=${POSTGRES_MIN_WAL_SIZE:?set POSTGRES_MIN_WAL_SIZE in .env}" \
  -c "wal_buffers=${POSTGRES_WAL_BUFFERS:?set POSTGRES_WAL_BUFFERS in .env}" \
  -c "wal_compression=${POSTGRES_WAL_COMPRESSION:?set POSTGRES_WAL_COMPRESSION in .env}" \
  -c "autovacuum=${POSTGRES_AUTOVACUUM:?set POSTGRES_AUTOVACUUM in .env}" \
  -c "autovacuum_max_workers=${POSTGRES_AUTOVACUUM_MAX_WORKERS:?set POSTGRES_AUTOVACUUM_MAX_WORKERS in .env}" \
  -c "autovacuum_naptime=${POSTGRES_AUTOVACUUM_NAPTIME:?set POSTGRES_AUTOVACUUM_NAPTIME in .env}" \
  -c "autovacuum_vacuum_scale_factor=${POSTGRES_AUTOVACUUM_VACUUM_SCALE_FACTOR:?set POSTGRES_AUTOVACUUM_VACUUM_SCALE_FACTOR in .env}" \
  -c "autovacuum_analyze_scale_factor=${POSTGRES_AUTOVACUUM_ANALYZE_SCALE_FACTOR:?set POSTGRES_AUTOVACUUM_ANALYZE_SCALE_FACTOR in .env}" \
  -c "autovacuum_vacuum_threshold=${POSTGRES_AUTOVACUUM_VACUUM_THRESHOLD:?set POSTGRES_AUTOVACUUM_VACUUM_THRESHOLD in .env}" \
  -c "autovacuum_analyze_threshold=${POSTGRES_AUTOVACUUM_ANALYZE_THRESHOLD:?set POSTGRES_AUTOVACUUM_ANALYZE_THRESHOLD in .env}" \
  -c "idle_in_transaction_session_timeout=${POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT:?set POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT in .env}" \
  -c "statement_timeout=${POSTGRES_STATEMENT_TIMEOUT:?set POSTGRES_STATEMENT_TIMEOUT in .env}" \
  -c "lock_timeout=${POSTGRES_LOCK_TIMEOUT:?set POSTGRES_LOCK_TIMEOUT in .env}" \
  -c "log_min_duration_statement=${POSTGRES_LOG_MIN_DURATION_STATEMENT:?set POSTGRES_LOG_MIN_DURATION_STATEMENT in .env}"

exec docker-entrypoint.sh "$@"
