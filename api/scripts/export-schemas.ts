import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiSchemaDocument, SCHEMA_PATH, serialize } from '../src/schema-export.js';

// Writes api/schemas/api.schema.json. The agent generates its pydantic models from this file.
writeFileSync(SCHEMA_PATH, serialize(apiSchemaDocument()));
console.log(`wrote ${fileURLToPath(SCHEMA_PATH)}`);
