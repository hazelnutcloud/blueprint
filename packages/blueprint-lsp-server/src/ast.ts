import type { Node, Tree } from "./parser";

/**
 * Source location information for AST nodes.
 */
export interface SourceLocation {
  /** Start line (0-indexed) */
  startLine: number;
  /** Start column (0-indexed) */
  startColumn: number;
  /** End line (0-indexed) */
  endLine: number;
  /** End column (0-indexed) */
  endColumn: number;
  /** Start offset in the source text */
  startOffset: number;
  /** End offset in the source text */
  endOffset: number;
}

/**
 * Base interface for all AST nodes.
 */
export interface ASTNode {
  /** The type of the node */
  type: string;
  /** Source location of this node */
  location: SourceLocation;
}

/**
 * A reference to another element using dot notation (e.g., "module.feature.requirement").
 */
export interface ReferenceNode extends ASTNode {
  type: "reference";
  /** The parts of the reference (e.g., ["module", "feature", "requirement"]) */
  parts: string[];
  /** The full reference as a string (e.g., "module.feature.requirement") */
  path: string;
}

/**
 * A @depends-on annotation declaring dependencies.
 */
export interface DependsOnNode extends ASTNode {
  type: "depends_on";
  /** The references this element depends on */
  references: ReferenceNode[];
}

/**
 * A @constraint annotation defining implementation requirements.
 */
export interface ConstraintNode extends ASTNode {
  type: "constraint";
  /** The identifier of the constraint */
  name: string;
  /** The description text of the constraint */
  description: string;
}

/**
 * A @requirement block - the leaf node representing implementable units.
 */
export interface RequirementNode extends ASTNode {
  type: "requirement";
  /** The identifier of the requirement */
  name: string;
  /** The description text of the requirement */
  description: string;
  /** Dependencies declared on this requirement */
  dependencies: DependsOnNode[];
  /** Constraints that must be satisfied */
  constraints: ConstraintNode[];
}

/**
 * A @feature block - user-facing capabilities within a module.
 */
export interface FeatureNode extends ASTNode {
  type: "feature";
  /** The identifier of the feature */
  name: string;
  /** The description text of the feature */
  description: string;
  /** Dependencies declared on this feature */
  dependencies: DependsOnNode[];
  /** Constraints declared on this feature (inherited by requirements) */
  constraints: ConstraintNode[];
  /** Requirements within this feature */
  requirements: RequirementNode[];
}

/**
 * A @module block - major system boundaries or architectural components.
 */
export interface ModuleNode extends ASTNode {
  type: "module";
  /** The identifier of the module */
  name: string;
  /** The description text of the module */
  description: string;
  /** Dependencies declared on this module */
  dependencies: DependsOnNode[];
  /** Constraints declared on this module (inherited by features/requirements) */
  constraints: ConstraintNode[];
  /** Features within this module */
  features: FeatureNode[];
  /** Requirements directly in the module (not in a feature) */
  requirements: RequirementNode[];
}

/**
 * A @description block at the document level.
 */
export interface DescriptionNode extends ASTNode {
  type: "description";
  /** The description text */
  text: string;
}

/**
 * The root document node representing a complete .bp file.
 */
export interface DocumentNode extends ASTNode {
  type: "document";
  /** The document-level description, if present */
  description: DescriptionNode | null;
  /** The modules defined in this document */
  modules: ModuleNode[];
}

/**
 * Extract the source location from a tree-sitter node.
 */
function getLocation(node: Node): SourceLocation {
  return {
    startLine: node.startPosition.row,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row,
    endColumn: node.endPosition.column,
    startOffset: node.startIndex,
    endOffset: node.endIndex,
  };
}

/**
 * Extract text from description_text and code_block children.
 */
function extractDescription(node: Node): string {
  const parts: string[] = [];

  for (const child of node.children) {
    if (child.type === "description_text") {
      parts.push(child.text);
    } else if (child.type === "code_block") {
      parts.push(child.text);
    }
  }

  return parts.join("\n").trim();
}

/**
 * Transform a tree-sitter reference node into a ReferenceNode.
 */
function transformReference(node: Node): ReferenceNode {
  const parts: string[] = [];

  for (const child of node.children) {
    if (child.type === "identifier") {
      parts.push(child.text);
    }
  }

  return {
    type: "reference",
    parts,
    path: parts.join("."),
    location: getLocation(node),
  };
}

/**
 * Transform a tree-sitter depends_on node into a DependsOnNode.
 */
function transformDependsOn(node: Node): DependsOnNode {
  const references: ReferenceNode[] = [];

  for (const child of node.children) {
    if (child.type === "reference") {
      references.push(transformReference(child));
    }
  }

  return {
    type: "depends_on",
    references,
    location: getLocation(node),
  };
}

/**
 * Transform a tree-sitter constraint node into a ConstraintNode.
 */
function transformConstraint(node: Node): ConstraintNode {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text ?? "";
  const description = extractDescription(node);

  return {
    type: "constraint",
    name,
    description,
    location: getLocation(node),
  };
}

/**
 * Transform a tree-sitter requirement_block node into a RequirementNode.
 */
function transformRequirement(node: Node): RequirementNode {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text ?? "";
  const description = extractDescription(node);
  const dependencies: DependsOnNode[] = [];
  const constraints: ConstraintNode[] = [];

  for (const child of node.children) {
    if (child.type === "depends_on") {
      dependencies.push(transformDependsOn(child));
    } else if (child.type === "constraint") {
      constraints.push(transformConstraint(child));
    }
  }

  return {
    type: "requirement",
    name,
    description,
    dependencies,
    constraints,
    location: getLocation(node),
  };
}

/**
 * Transform a tree-sitter feature_block node into a FeatureNode.
 */
function transformFeature(node: Node): FeatureNode {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text ?? "";
  const description = extractDescription(node);
  const dependencies: DependsOnNode[] = [];
  const constraints: ConstraintNode[] = [];
  const requirements: RequirementNode[] = [];

  for (const child of node.children) {
    if (child.type === "depends_on") {
      dependencies.push(transformDependsOn(child));
    } else if (child.type === "constraint") {
      constraints.push(transformConstraint(child));
    } else if (child.type === "requirement_block") {
      requirements.push(transformRequirement(child));
    }
  }

  return {
    type: "feature",
    name,
    description,
    dependencies,
    constraints,
    requirements,
    location: getLocation(node),
  };
}

/**
 * Transform a tree-sitter module_block node into a ModuleNode.
 */
function transformModule(node: Node): ModuleNode {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text ?? "";
  const description = extractDescription(node);
  const dependencies: DependsOnNode[] = [];
  const constraints: ConstraintNode[] = [];
  const features: FeatureNode[] = [];
  const requirements: RequirementNode[] = [];

  for (const child of node.children) {
    if (child.type === "depends_on") {
      dependencies.push(transformDependsOn(child));
    } else if (child.type === "constraint") {
      constraints.push(transformConstraint(child));
    } else if (child.type === "feature_block") {
      features.push(transformFeature(child));
    } else if (child.type === "requirement_block") {
      requirements.push(transformRequirement(child));
    }
  }

  return {
    type: "module",
    name,
    description,
    dependencies,
    constraints,
    features,
    requirements,
    location: getLocation(node),
  };
}

/**
 * Transform a tree-sitter description_block node into a DescriptionNode.
 */
function transformDescription(node: Node): DescriptionNode {
  const parts: string[] = [];

  for (const child of node.children) {
    if (child.type === "description_text") {
      parts.push(child.text);
    } else if (child.type === "code_block") {
      parts.push(child.text);
    }
  }

  return {
    type: "description",
    text: parts.join("\n").trim(),
    location: getLocation(node),
  };
}

/**
 * Transform a tree-sitter Tree into a Blueprint AST DocumentNode.
 *
 * @param tree The tree-sitter syntax tree to transform
 * @returns The AST representation of the document
 */
export function transformToAST(tree: Tree): DocumentNode {
  const root = tree.rootNode;
  let description: DescriptionNode | null = null;
  const modules: ModuleNode[] = [];

  for (const child of root.children) {
    if (child.type === "description_block") {
      description = transformDescription(child);
    } else if (child.type === "module_block") {
      modules.push(transformModule(child));
    }
  }

  return {
    type: "document",
    description,
    modules,
    location: getLocation(root),
  };
}

/**
 * Build a symbol table mapping fully-qualified names to AST nodes.
 * Keys use dot notation: "module", "module.feature", "module.feature.requirement"
 */
export interface SymbolTable {
  modules: Map<string, ModuleNode>;
  features: Map<string, FeatureNode>;
  requirements: Map<string, RequirementNode>;
  constraints: Map<string, ConstraintNode>;
}

/**
 * Represents a duplicate identifier detected during symbol table construction.
 * Contains both the original and duplicate nodes for diagnostic reporting.
 */
export interface DuplicateIdentifier {
  /** The type of element that has a duplicate */
  kind: "module" | "feature" | "requirement" | "constraint";
  /** The fully-qualified path of the duplicate */
  path: string;
  /** The original (first) node with this identifier */
  original: ASTNode;
  /** The duplicate node (second or later occurrence) */
  duplicate: ASTNode;
}

/**
 * Result of building a symbol table, including any duplicate identifiers found.
 */
export interface SymbolTableResult {
  /** The symbol table with unique entries (last one wins for duplicates) */
  symbolTable: SymbolTable;
  /** List of duplicate identifiers detected */
  duplicates: DuplicateIdentifier[];
}

/**
 * Build a symbol table from a DocumentNode.
 * Detects duplicate identifiers within the same scope and returns them
 * for diagnostic reporting. When duplicates exist, the last one wins
 * in the symbol table (for error recovery), but all duplicates are reported.
 */
export function buildSymbolTable(doc: DocumentNode): SymbolTableResult {
  const modules = new Map<string, ModuleNode>();
  const features = new Map<string, FeatureNode>();
  const requirements = new Map<string, RequirementNode>();
  const constraints = new Map<string, ConstraintNode>();
  const duplicates: DuplicateIdentifier[] = [];

  for (const mod of doc.modules) {
    const modPath = mod.name;

    // Check for duplicate module
    const existingModule = modules.get(modPath);
    if (existingModule) {
      duplicates.push({
        kind: "module",
        path: modPath,
        original: existingModule,
        duplicate: mod,
      });
    }
    modules.set(modPath, mod);

    // Module-level constraints
    for (const constraint of mod.constraints) {
      const constraintPath = `${modPath}.${constraint.name}`;
      const existingConstraint = constraints.get(constraintPath);
      if (existingConstraint) {
        duplicates.push({
          kind: "constraint",
          path: constraintPath,
          original: existingConstraint,
          duplicate: constraint,
        });
      }
      constraints.set(constraintPath, constraint);
    }

    // Module-level requirements (not in a feature)
    for (const req of mod.requirements) {
      const reqPath = `${modPath}.${req.name}`;
      const existingReq = requirements.get(reqPath);
      if (existingReq) {
        duplicates.push({
          kind: "requirement",
          path: reqPath,
          original: existingReq,
          duplicate: req,
        });
      }
      requirements.set(reqPath, req);

      for (const constraint of req.constraints) {
        const constraintPath = `${reqPath}.${constraint.name}`;
        const existingConstraint = constraints.get(constraintPath);
        if (existingConstraint) {
          duplicates.push({
            kind: "constraint",
            path: constraintPath,
            original: existingConstraint,
            duplicate: constraint,
          });
        }
        constraints.set(constraintPath, constraint);
      }
    }

    // Features
    for (const feature of mod.features) {
      const featurePath = `${modPath}.${feature.name}`;
      const existingFeature = features.get(featurePath);
      if (existingFeature) {
        duplicates.push({
          kind: "feature",
          path: featurePath,
          original: existingFeature,
          duplicate: feature,
        });
      }
      features.set(featurePath, feature);

      // Feature-level constraints
      for (const constraint of feature.constraints) {
        const constraintPath = `${featurePath}.${constraint.name}`;
        const existingConstraint = constraints.get(constraintPath);
        if (existingConstraint) {
          duplicates.push({
            kind: "constraint",
            path: constraintPath,
            original: existingConstraint,
            duplicate: constraint,
          });
        }
        constraints.set(constraintPath, constraint);
      }

      // Requirements in the feature
      for (const req of feature.requirements) {
        const reqPath = `${featurePath}.${req.name}`;
        const existingReq = requirements.get(reqPath);
        if (existingReq) {
          duplicates.push({
            kind: "requirement",
            path: reqPath,
            original: existingReq,
            duplicate: req,
          });
        }
        requirements.set(reqPath, req);

        for (const constraint of req.constraints) {
          const constraintPath = `${reqPath}.${constraint.name}`;
          const existingConstraint = constraints.get(constraintPath);
          if (existingConstraint) {
            duplicates.push({
              kind: "constraint",
              path: constraintPath,
              original: existingConstraint,
              duplicate: constraint,
            });
          }
          constraints.set(constraintPath, constraint);
        }
      }
    }
  }

  return {
    symbolTable: { modules, features, requirements, constraints },
    duplicates,
  };
}

/**
 * Get the fully-qualified path for a requirement.
 * Walks up the hierarchy to construct the path.
 */
export function getRequirementPath(doc: DocumentNode, requirement: RequirementNode): string | null {
  for (const mod of doc.modules) {
    // Check module-level requirements
    for (const req of mod.requirements) {
      if (req === requirement) {
        return `${mod.name}.${req.name}`;
      }
    }

    // Check feature requirements
    for (const feature of mod.features) {
      for (const req of feature.requirements) {
        if (req === requirement) {
          return `${mod.name}.${feature.name}.${req.name}`;
        }
      }
    }
  }

  return null;
}

/**
 * Find all requirements in a document.
 */
export function getAllRequirements(doc: DocumentNode): RequirementNode[] {
  const requirements: RequirementNode[] = [];

  for (const mod of doc.modules) {
    // Module-level requirements
    requirements.push(...mod.requirements);

    // Feature requirements
    for (const feature of mod.features) {
      requirements.push(...feature.requirements);
    }
  }

  return requirements;
}

/**
 * Find all constraints in a document.
 */
export function getAllConstraints(doc: DocumentNode): ConstraintNode[] {
  const constraints: ConstraintNode[] = [];

  for (const mod of doc.modules) {
    constraints.push(...mod.constraints);

    for (const req of mod.requirements) {
      constraints.push(...req.constraints);
    }

    for (const feature of mod.features) {
      constraints.push(...feature.constraints);

      for (const req of feature.requirements) {
        constraints.push(...req.constraints);
      }
    }
  }

  return constraints;
}
