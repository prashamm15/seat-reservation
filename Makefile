BASE_URL ?= http://localhost:8080
ARGS ?=

.PHONY: burst test dev

burst:
	node scripts/burst.js $(BASE_URL) $(ARGS)

test:
	npm test

dev:
	npm run dev
