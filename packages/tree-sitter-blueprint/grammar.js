/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

/**
 * Tree-sitter grammar for Blueprint DSL
 *
 * Blueprint is a domain-specific language for writing software requirements
 * that integrates with coding agents through an LSP-powered development experience.
 */
module.exports = grammar({
  name: "blueprint",

  // Tokens that can appear anywhere (whitespace, comments)
  extras: ($) => [/\s/, $.comment],

  rules: {
    // Top-level document structure
    // document = [ description ] { module }
    source_file: ($) =>
      seq(optional($.description_block), repeat($.module_block)),

    // ============================================
    // Comments
    // ============================================

    comment: ($) =>
      choice(
        // Single-line comment: // ...
        token(seq("//", /[^\n]*/)),
        // Multi-line comment: /* ... */
        token(seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/"))
      ),

    // ============================================
    // Document-Level Keywords
    // ============================================

    // @description block - provides high-level description of the software system
    description_block: ($) => seq("@description", repeat($._block_content)),

    // ============================================
    // Hierarchy Keywords
    // ============================================

    // @module - major system boundaries or architectural components
    module_block: ($) =>
      prec.right(
        seq(
          "@module",
          field("name", $.identifier),
          repeat($._module_item)
        )
      ),

    // Items in a module - can be description, features, requirements, or annotations
    _module_item: ($) =>
      choice(
        $._block_content,
        $.feature_block,
        $.requirement_block,
        $.depends_on,
        $.constraint
      ),

    // @feature - user-facing capabilities within a module
    feature_block: ($) =>
      prec.right(
        seq(
          "@feature",
          field("name", $.identifier),
          repeat($._feature_item)
        )
      ),

    // Items in a feature - can be description, requirements, or annotations
    _feature_item: ($) =>
      choice($._block_content, $.requirement_block, $.depends_on, $.constraint),

    // @requirement - specific, implementable units of functionality
    requirement_block: ($) =>
      prec.right(
        seq(
          "@requirement",
          field("name", $.identifier),
          repeat($._requirement_item)
        )
      ),

    // Items in a requirement - can be description or annotations
    _requirement_item: ($) =>
      choice($._block_content, $.depends_on, $.constraint),

    // ============================================
    // Annotation Keywords
    // ============================================

    // @depends-on - declares dependency relationships
    depends_on: ($) =>
      seq("@depends-on", $.reference, repeat(seq(",", $.reference))),

    // @constraint - implementation requirements that must be satisfied
    constraint: ($) =>
      prec.right(
        seq(
          "@constraint",
          field("name", $.identifier),
          repeat($._block_content)
        )
      ),

    // ============================================
    // Primitives
    // ============================================

    // Reference using dot notation: module.feature.requirement
    reference: ($) =>
      prec.left(seq($.identifier, repeat(seq(".", $.identifier)))),

    // Identifier: starts with letter or underscore, contains letters, digits, underscores, hyphens
    identifier: ($) => /[a-zA-Z_][a-zA-Z0-9_-]*/,

    // Block content - description text or code blocks
    _block_content: ($) => choice($.description_text, $.code_block),

    // Description text - a line of prose that is NOT a keyword line
    // Key insight: must start with something that can't be confused with keywords
    // Using prec(-2) to give lower priority than identifier/keyword matching
    description_text: ($) =>
      token(
        prec(
          -2,
          /[^@`\/\n\r\t ][^\n\r]*[ \t\w][^\n\r]*|[^@`\/\n\r\t ][^\n\r]+/
        )
      ),

    // Fenced code block: ``` ... ```
    code_block: ($) =>
      seq(
        "```",
        optional(field("language", $.code_language)),
        optional($.code_content),
        "```"
      ),

    // Language identifier for code blocks
    code_language: ($) => token.immediate(/[a-zA-Z][a-zA-Z0-9_-]*/),

    // Content inside a code block - everything until closing ```
    code_content: ($) => token(prec(-1, /([^`]|`[^`]|``[^`])+/)),
  },
});
