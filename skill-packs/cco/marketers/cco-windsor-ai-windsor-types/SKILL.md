---
name: windsor-types
description: Generate TypeScript type definitions for a Windsor.ai connector's data schema
---

# /windsor-types

Generate TypeScript type definitions for a Windsor.ai connector's data schema.

## Instructions

1. Ask the user which connector to generate types for (or use the one they specify).
2. Call `get_connectors` to get the account ID.
3. Call `get_options` to get all available fields.
4. Call `get_fields` with all the field IDs to get their data types and descriptions.
5. Generate a TypeScript interface with:
   - JSDoc comments from the field descriptions
   - Correct TypeScript types mapped from Windsor field types (string, number, date, etc.)
   - An exported type name like `GoogleAdsRow`, `FacebookRow`, etc.
6. Write the file to the project (e.g. `src/types/windsor-{connector}.ts` or wherever types live in the project).
