.PHONY: lint test build full

NPM ?= npm
VITEST_POOL ?= threads
VITEST_MAX_WORKERS ?= 1
VITEST_TEST_TIMEOUT ?= 120000
VITEST_HOOK_TIMEOUT ?= 120000
BACKEND_TEST_TIMEOUT ?= 180000
BACKEND_HOOK_TIMEOUT ?= 180000

lint:
	$(NPM) run lint

test:
	$(NPM) run test -- --pool $(VITEST_POOL) --maxWorkers $(VITEST_MAX_WORKERS) --testTimeout $(VITEST_TEST_TIMEOUT) --hookTimeout $(VITEST_HOOK_TIMEOUT)

build:
	$(NPM) run build

full:
	$(NPM) run lint
	$(NPM) run test -- --pool $(VITEST_POOL) --maxWorkers $(VITEST_MAX_WORKERS) --testTimeout $(VITEST_TEST_TIMEOUT) --hookTimeout $(VITEST_HOOK_TIMEOUT)
	$(NPM) run test:backend-integration -- --testTimeout $(BACKEND_TEST_TIMEOUT) --hookTimeout $(BACKEND_HOOK_TIMEOUT)
	$(NPM) run build
