// What each form takes, as Effect Schema through Standard Schema (TanStack Form's validators).
import { Schema } from "effect"

/** Kinds a person adds by hand, in the order the menu lists them. */
export const ADDABLE = [
  "phone",
  "email",
  "company",
  "role",
  "location",
  "birthday",
  "url",
  "note",
  "name",
] as const

const filled = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())

const addField = Schema.Struct({ kind: Schema.Literals(ADDABLE), value: filled })
export const addFieldForm = Schema.toStandardSchemaV1(addField)

/** A blank add-field line. */
export const BLANK_FIELD: { kind: (typeof ADDABLE)[number]; value: string } = {
  kind: "phone",
  value: "",
}

export const newPersonForm = Schema.toStandardSchemaV1(
  Schema.Struct({ name: filled, phone: Schema.String, email: Schema.String }),
)

export const searchForm = Schema.toStandardSchemaV1(Schema.Struct({ query: Schema.String }))
