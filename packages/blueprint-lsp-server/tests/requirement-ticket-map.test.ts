import { describe, test, expect } from "bun:test";
import {
  groupTicketsByRef,
  computeRequirementStatus,
  computeConstraintStatuses,
  collectImplementationFiles,
  collectTestFiles,
  buildRequirementTicketMap,
  buildRequirementTicketMapFromSymbols,
  getCompletionSummary,
  filterByPathPrefix,
  type RequirementTicketInfo,
  type RequirementStatus,
} from "../src/requirement-ticket-map";
import type { RequirementNode, ConstraintNode, SourceLocation } from "../src/ast";
import type { Ticket, TicketFile } from "../src/tickets";
import type { IndexedSymbol } from "../src/symbol-index";

// ============================================================================
// Test Helpers
// ============================================================================

const dummyLocation: SourceLocation = {
  startLine: 0,
  startColumn: 0,
  endLine: 0,
  endColumn: 0,
  startOffset: 0,
  endOffset: 0,
};

function createConstraint(name: string): ConstraintNode {
  return {
    type: "constraint",
    name,
    description: `Constraint ${name}`,
    location: dummyLocation,
  };
}

function createRequirement(name: string, constraints: string[] = []): RequirementNode {
  return {
    type: "requirement",
    name,
    description: `Requirement ${name}`,
    dependencies: [],
    constraints: constraints.map(createConstraint),
    location: dummyLocation,
  };
}

function createTicket(
  id: string,
  ref: string,
  status: Ticket["status"],
  constraintsSatisfied: string[] = [],
  implementation?: { files?: string[]; tests?: string[] }
): Ticket {
  return {
    id,
    ref,
    description: `Ticket ${id}`,
    status,
    constraints_satisfied: constraintsSatisfied,
    implementation,
  };
}

function createTicketFile(source: string, tickets: Ticket[]): TicketFile {
  return {
    version: "1.0",
    source,
    tickets,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("requirement-ticket-map", () => {
  describe("groupTicketsByRef", () => {
    test("groups tickets by their ref", () => {
      const tickets = [
        createTicket("TKT-001", "auth.login.basic", "pending"),
        createTicket("TKT-002", "auth.login.basic", "in-progress"),
        createTicket("TKT-003", "auth.login.oauth", "complete"),
      ];

      const grouped = groupTicketsByRef(tickets);

      expect(grouped.size).toBe(2);
      expect(grouped.get("auth.login.basic")).toHaveLength(2);
      expect(grouped.get("auth.login.oauth")).toHaveLength(1);
    });

    test("returns empty map for empty input", () => {
      const grouped = groupTicketsByRef([]);
      expect(grouped.size).toBe(0);
    });

    test("handles single ticket per ref", () => {
      const tickets = [
        createTicket("TKT-001", "auth.login", "pending"),
        createTicket("TKT-002", "auth.logout", "pending"),
        createTicket("TKT-003", "payments.checkout", "pending"),
      ];

      const grouped = groupTicketsByRef(tickets);

      expect(grouped.size).toBe(3);
      expect(grouped.get("auth.login")).toHaveLength(1);
      expect(grouped.get("auth.logout")).toHaveLength(1);
      expect(grouped.get("payments.checkout")).toHaveLength(1);
    });
  });

  describe("computeRequirementStatus", () => {
    test("returns 'no-ticket' for empty tickets array", () => {
      expect(computeRequirementStatus([])).toBe("no-ticket");
    });

    test("returns 'pending' when all tickets are pending", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "pending"),
        createTicket("TKT-002", "ref", "pending"),
      ];
      expect(computeRequirementStatus(tickets)).toBe("pending");
    });

    test("returns 'in-progress' when any ticket is in-progress", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "pending"),
        createTicket("TKT-002", "ref", "in-progress"),
        createTicket("TKT-003", "ref", "complete"),
      ];
      expect(computeRequirementStatus(tickets)).toBe("in-progress");
    });

    test("returns 'complete' when all tickets are complete", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "complete"),
        createTicket("TKT-002", "ref", "complete"),
      ];
      expect(computeRequirementStatus(tickets)).toBe("complete");
    });

    test("returns 'obsolete' when all tickets are obsolete", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "obsolete"),
        createTicket("TKT-002", "ref", "obsolete"),
      ];
      expect(computeRequirementStatus(tickets)).toBe("obsolete");
    });

    test("returns 'pending' for mix of pending and complete", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "pending"),
        createTicket("TKT-002", "ref", "complete"),
      ];
      expect(computeRequirementStatus(tickets)).toBe("pending");
    });

    test("ignores obsolete tickets when computing status", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "complete"),
        createTicket("TKT-002", "ref", "obsolete"),
      ];
      expect(computeRequirementStatus(tickets)).toBe("complete");
    });

    test("returns 'in-progress' over 'pending' even with obsolete tickets", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "in-progress"),
        createTicket("TKT-002", "ref", "obsolete"),
        createTicket("TKT-003", "ref", "pending"),
      ];
      expect(computeRequirementStatus(tickets)).toBe("in-progress");
    });
  });

  describe("computeConstraintStatuses", () => {
    test("returns empty array for requirement with no constraints", () => {
      const req = createRequirement("basic-auth", []);
      const tickets = [createTicket("TKT-001", "ref", "complete", ["some-constraint"])];

      const statuses = computeConstraintStatuses(req, tickets);

      expect(statuses).toHaveLength(0);
    });

    test("marks constraints as unsatisfied when no tickets satisfy them", () => {
      const req = createRequirement("basic-auth", ["bcrypt", "rate-limit"]);
      const tickets: Ticket[] = [];

      const statuses = computeConstraintStatuses(req, tickets);

      expect(statuses).toHaveLength(2);
      expect(statuses[0]).toEqual({
        name: "bcrypt",
        satisfied: false,
        satisfiedBy: [],
      });
      expect(statuses[1]).toEqual({
        name: "rate-limit",
        satisfied: false,
        satisfiedBy: [],
      });
    });

    test("marks constraints as satisfied when tickets satisfy them", () => {
      const req = createRequirement("basic-auth", ["bcrypt", "rate-limit"]);
      const tickets = [
        createTicket("TKT-001", "ref", "complete", ["bcrypt"]),
        createTicket("TKT-002", "ref", "complete", ["rate-limit"]),
      ];

      const statuses = computeConstraintStatuses(req, tickets);

      expect(statuses).toHaveLength(2);
      expect(statuses[0]).toEqual({
        name: "bcrypt",
        satisfied: true,
        satisfiedBy: ["TKT-001"],
      });
      expect(statuses[1]).toEqual({
        name: "rate-limit",
        satisfied: true,
        satisfiedBy: ["TKT-002"],
      });
    });

    test("handles multiple tickets satisfying the same constraint", () => {
      const req = createRequirement("basic-auth", ["bcrypt"]);
      const tickets = [
        createTicket("TKT-001", "ref", "complete", ["bcrypt"]),
        createTicket("TKT-002", "ref", "complete", ["bcrypt"]),
      ];

      const statuses = computeConstraintStatuses(req, tickets);

      expect(statuses[0]).toEqual({
        name: "bcrypt",
        satisfied: true,
        satisfiedBy: ["TKT-001", "TKT-002"],
      });
    });

    test("handles partial constraint satisfaction", () => {
      const req = createRequirement("basic-auth", ["bcrypt", "rate-limit", "audit-log"]);
      const tickets = [createTicket("TKT-001", "ref", "complete", ["bcrypt", "audit-log"])];

      const statuses = computeConstraintStatuses(req, tickets);

      expect(statuses).toHaveLength(3);
      expect(statuses.find((s) => s.name === "bcrypt")?.satisfied).toBe(true);
      expect(statuses.find((s) => s.name === "rate-limit")?.satisfied).toBe(false);
      expect(statuses.find((s) => s.name === "audit-log")?.satisfied).toBe(true);
    });

    test("ignores constraint names in tickets that don't exist in requirement", () => {
      const req = createRequirement("basic-auth", ["bcrypt"]);
      const tickets = [
        createTicket("TKT-001", "ref", "complete", ["bcrypt", "unknown-constraint"]),
      ];

      const statuses = computeConstraintStatuses(req, tickets);

      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.name).toBe("bcrypt");
    });
  });

  describe("collectImplementationFiles", () => {
    test("returns empty array for tickets without implementation", () => {
      const tickets = [createTicket("TKT-001", "ref", "pending")];

      expect(collectImplementationFiles(tickets)).toEqual([]);
    });

    test("collects files from single ticket", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "complete", [], {
          files: ["src/auth/login.ts", "src/auth/password.ts"],
        }),
      ];

      const files = collectImplementationFiles(tickets);

      expect(files).toHaveLength(2);
      expect(files).toContain("src/auth/login.ts");
      expect(files).toContain("src/auth/password.ts");
    });

    test("deduplicates files across tickets", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "complete", [], {
          files: ["src/auth/login.ts", "src/auth/password.ts"],
        }),
        createTicket("TKT-002", "ref", "complete", [], {
          files: ["src/auth/login.ts", "src/auth/rate-limit.ts"],
        }),
      ];

      const files = collectImplementationFiles(tickets);

      expect(files).toHaveLength(3);
      expect(files).toContain("src/auth/login.ts");
      expect(files).toContain("src/auth/password.ts");
      expect(files).toContain("src/auth/rate-limit.ts");
    });

    test("handles empty files array", () => {
      const tickets = [createTicket("TKT-001", "ref", "complete", [], { files: [] })];

      expect(collectImplementationFiles(tickets)).toEqual([]);
    });
  });

  describe("collectTestFiles", () => {
    test("returns empty array for tickets without tests", () => {
      const tickets = [createTicket("TKT-001", "ref", "pending")];

      expect(collectTestFiles(tickets)).toEqual([]);
    });

    test("collects test files from tickets", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "complete", [], {
          tests: ["tests/auth/login.test.ts"],
        }),
        createTicket("TKT-002", "ref", "complete", [], {
          tests: ["tests/auth/rate-limit.test.ts"],
        }),
      ];

      const files = collectTestFiles(tickets);

      expect(files).toHaveLength(2);
      expect(files).toContain("tests/auth/login.test.ts");
      expect(files).toContain("tests/auth/rate-limit.test.ts");
    });

    test("deduplicates test files", () => {
      const tickets = [
        createTicket("TKT-001", "ref", "complete", [], {
          tests: ["tests/auth/login.test.ts"],
        }),
        createTicket("TKT-002", "ref", "complete", [], {
          tests: ["tests/auth/login.test.ts"],
        }),
      ];

      const files = collectTestFiles(tickets);

      expect(files).toHaveLength(1);
    });
  });

  describe("buildRequirementTicketMap", () => {
    test("builds map with matching requirements and tickets", () => {
      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic", createRequirement("basic", ["bcrypt", "rate-limit"])],
        ["auth.login.oauth", createRequirement("oauth", ["csrf"])],
      ]);

      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic", "complete", ["bcrypt"]),
        createTicket("TKT-002", "auth.login.basic", "in-progress", ["rate-limit"]),
        createTicket("TKT-003", "auth.login.oauth", "pending"),
      ]);

      const result = buildRequirementTicketMap(requirements, ticketFile);

      expect(result.map.size).toBe(2);
      expect(result.orphanedTickets).toHaveLength(0);
      expect(result.requirementsWithoutTickets).toHaveLength(0);

      const basicInfo = result.map.get("auth.login.basic");
      expect(basicInfo?.tickets).toHaveLength(2);
      expect(basicInfo?.status).toBe("in-progress");
      expect(basicInfo?.constraintsSatisfied).toBe(2);
      expect(basicInfo?.constraintsTotal).toBe(2);

      const oauthInfo = result.map.get("auth.login.oauth");
      expect(oauthInfo?.tickets).toHaveLength(1);
      expect(oauthInfo?.status).toBe("pending");
      expect(oauthInfo?.constraintsSatisfied).toBe(0);
      expect(oauthInfo?.constraintsTotal).toBe(1);
    });

    test("identifies requirements without tickets", () => {
      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic", createRequirement("basic")],
        ["auth.login.oauth", createRequirement("oauth")],
      ]);

      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic", "pending"),
      ]);

      const result = buildRequirementTicketMap(requirements, ticketFile);

      expect(result.requirementsWithoutTickets).toEqual(["auth.login.oauth"]);

      const oauthInfo = result.map.get("auth.login.oauth");
      expect(oauthInfo?.status).toBe("no-ticket");
      expect(oauthInfo?.tickets).toHaveLength(0);
    });

    test("identifies orphaned tickets", () => {
      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic", createRequirement("basic")],
      ]);

      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic", "pending"),
        createTicket("TKT-002", "auth.login.nonexistent", "pending"),
        createTicket("TKT-003", "payments.checkout", "pending"),
      ]);

      const result = buildRequirementTicketMap(requirements, ticketFile);

      expect(result.orphanedTickets).toHaveLength(2);
      expect(result.orphanedTickets.map((o) => o.ref)).toContain("auth.login.nonexistent");
      expect(result.orphanedTickets.map((o) => o.ref)).toContain("payments.checkout");
    });

    test("handles null ticket file", () => {
      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic", createRequirement("basic")],
      ]);

      const result = buildRequirementTicketMap(requirements, null);

      expect(result.map.size).toBe(1);
      expect(result.orphanedTickets).toHaveLength(0);
      expect(result.requirementsWithoutTickets).toEqual(["auth.login.basic"]);

      const info = result.map.get("auth.login.basic");
      expect(info?.status).toBe("no-ticket");
    });

    test("handles empty requirements map", () => {
      const requirements = new Map<string, RequirementNode>();

      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic", "pending"),
      ]);

      const result = buildRequirementTicketMap(requirements, ticketFile);

      expect(result.map.size).toBe(0);
      expect(result.orphanedTickets).toHaveLength(1);
      expect(result.requirementsWithoutTickets).toHaveLength(0);
    });

    test("collects implementation files in result", () => {
      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic", createRequirement("basic")],
      ]);

      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic", "complete", [], {
          files: ["src/auth/login.ts"],
          tests: ["tests/auth/login.test.ts"],
        }),
        createTicket("TKT-002", "auth.login.basic", "complete", [], {
          files: ["src/auth/password.ts"],
          tests: ["tests/auth/password.test.ts"],
        }),
      ]);

      const result = buildRequirementTicketMap(requirements, ticketFile);
      const info = result.map.get("auth.login.basic");

      expect(info?.implementationFiles).toHaveLength(2);
      expect(info?.implementationFiles).toContain("src/auth/login.ts");
      expect(info?.implementationFiles).toContain("src/auth/password.ts");

      expect(info?.testFiles).toHaveLength(2);
      expect(info?.testFiles).toContain("tests/auth/login.test.ts");
      expect(info?.testFiles).toContain("tests/auth/password.test.ts");
    });
  });

  describe("buildRequirementTicketMapFromSymbols", () => {
    test("builds map from indexed symbols", () => {
      const symbols: IndexedSymbol[] = [
        {
          path: "auth.login.basic",
          kind: "requirement",
          fileUri: "file:///project/auth.bp",
          node: createRequirement("basic", ["bcrypt"]),
        },
        {
          path: "auth.login.oauth",
          kind: "requirement",
          fileUri: "file:///project/auth.bp",
          node: createRequirement("oauth"),
        },
      ];

      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic", "complete", ["bcrypt"]),
      ]);

      const result = buildRequirementTicketMapFromSymbols(symbols, ticketFile);

      expect(result.map.size).toBe(2);
      expect(result.map.get("auth.login.basic")?.status).toBe("complete");
      expect(result.map.get("auth.login.oauth")?.status).toBe("no-ticket");
    });

    test("filters out non-requirement symbols", () => {
      const symbols: IndexedSymbol[] = [
        {
          path: "auth",
          kind: "module",
          fileUri: "file:///project/auth.bp",
          node: {} as any, // We only care about requirements
        },
        {
          path: "auth.login",
          kind: "feature",
          fileUri: "file:///project/auth.bp",
          node: {} as any,
        },
        {
          path: "auth.login.basic",
          kind: "requirement",
          fileUri: "file:///project/auth.bp",
          node: createRequirement("basic"),
        },
      ];

      const result = buildRequirementTicketMapFromSymbols(symbols, null);

      expect(result.map.size).toBe(1);
      expect(result.map.has("auth.login.basic")).toBe(true);
    });
  });

  describe("getCompletionSummary", () => {
    test("computes summary for mixed statuses", () => {
      const map = new Map<string, RequirementTicketInfo>();

      // Add requirements with different statuses
      const statuses: RequirementStatus[] = [
        "complete",
        "complete",
        "in-progress",
        "pending",
        "no-ticket",
        "obsolete",
      ];

      statuses.forEach((status, i) => {
        map.set(`req-${i}`, {
          requirementPath: `req-${i}`,
          requirement: createRequirement(`req-${i}`),
          tickets: [],
          status,
          constraintStatuses: [],
          constraintsSatisfied: 0,
          constraintsTotal: 0,
          implementationFiles: [],
          testFiles: [],
        });
      });

      const summary = getCompletionSummary(map);

      expect(summary.total).toBe(6);
      expect(summary.complete).toBe(2);
      expect(summary.inProgress).toBe(1);
      expect(summary.pending).toBe(1);
      expect(summary.noTicket).toBe(1);
      expect(summary.obsolete).toBe(1);
      expect(summary.percentComplete).toBe(33); // 2/6 = 33%
    });

    test("returns zeros for empty map", () => {
      const summary = getCompletionSummary(new Map());

      expect(summary.total).toBe(0);
      expect(summary.complete).toBe(0);
      expect(summary.percentComplete).toBe(0);
    });

    test("computes 100% for all complete", () => {
      const map = new Map<string, RequirementTicketInfo>();

      for (let i = 0; i < 5; i++) {
        map.set(`req-${i}`, {
          requirementPath: `req-${i}`,
          requirement: createRequirement(`req-${i}`),
          tickets: [],
          status: "complete",
          constraintStatuses: [],
          constraintsSatisfied: 0,
          constraintsTotal: 0,
          implementationFiles: [],
          testFiles: [],
        });
      }

      const summary = getCompletionSummary(map);

      expect(summary.percentComplete).toBe(100);
    });
  });

  describe("filterByPathPrefix", () => {
    test("filters requirements by module prefix", () => {
      const map = new Map<string, RequirementTicketInfo>();

      const paths = [
        "auth.login.basic",
        "auth.login.oauth",
        "auth.logout.session",
        "payments.checkout.cart",
        "payments.refund.process",
      ];

      paths.forEach((path) => {
        map.set(path, {
          requirementPath: path,
          requirement: createRequirement(path.split(".").pop()!),
          tickets: [],
          status: "pending",
          constraintStatuses: [],
          constraintsSatisfied: 0,
          constraintsTotal: 0,
          implementationFiles: [],
          testFiles: [],
        });
      });

      const authOnly = filterByPathPrefix(map, "auth");

      expect(authOnly.size).toBe(3);
      expect(authOnly.has("auth.login.basic")).toBe(true);
      expect(authOnly.has("auth.login.oauth")).toBe(true);
      expect(authOnly.has("auth.logout.session")).toBe(true);
      expect(authOnly.has("payments.checkout.cart")).toBe(false);
    });

    test("filters requirements by feature prefix", () => {
      const map = new Map<string, RequirementTicketInfo>();

      const paths = ["auth.login.basic", "auth.login.oauth", "auth.logout.session"];

      paths.forEach((path) => {
        map.set(path, {
          requirementPath: path,
          requirement: createRequirement(path.split(".").pop()!),
          tickets: [],
          status: "pending",
          constraintStatuses: [],
          constraintsSatisfied: 0,
          constraintsTotal: 0,
          implementationFiles: [],
          testFiles: [],
        });
      });

      const loginOnly = filterByPathPrefix(map, "auth.login");

      expect(loginOnly.size).toBe(2);
      expect(loginOnly.has("auth.login.basic")).toBe(true);
      expect(loginOnly.has("auth.login.oauth")).toBe(true);
      expect(loginOnly.has("auth.logout.session")).toBe(false);
    });

    test("returns empty map when no matches", () => {
      const map = new Map<string, RequirementTicketInfo>();
      map.set("auth.login.basic", {
        requirementPath: "auth.login.basic",
        requirement: createRequirement("basic"),
        tickets: [],
        status: "pending",
        constraintStatuses: [],
        constraintsSatisfied: 0,
        constraintsTotal: 0,
        implementationFiles: [],
        testFiles: [],
      });

      const filtered = filterByPathPrefix(map, "payments");

      expect(filtered.size).toBe(0);
    });

    test("matches exact path", () => {
      const map = new Map<string, RequirementTicketInfo>();
      map.set("auth.login.basic", {
        requirementPath: "auth.login.basic",
        requirement: createRequirement("basic"),
        tickets: [],
        status: "pending",
        constraintStatuses: [],
        constraintsSatisfied: 0,
        constraintsTotal: 0,
        implementationFiles: [],
        testFiles: [],
      });

      const filtered = filterByPathPrefix(map, "auth.login.basic");

      expect(filtered.size).toBe(1);
      expect(filtered.has("auth.login.basic")).toBe(true);
    });

    test("does not match partial identifiers", () => {
      const map = new Map<string, RequirementTicketInfo>();

      // "auth" should not match "authentication"
      map.set("authentication.login.basic", {
        requirementPath: "authentication.login.basic",
        requirement: createRequirement("basic"),
        tickets: [],
        status: "pending",
        constraintStatuses: [],
        constraintsSatisfied: 0,
        constraintsTotal: 0,
        implementationFiles: [],
        testFiles: [],
      });

      const filtered = filterByPathPrefix(map, "auth");

      expect(filtered.size).toBe(0);
    });
  });
});
