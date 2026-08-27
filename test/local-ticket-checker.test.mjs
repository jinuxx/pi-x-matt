import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "check-local-ticket.mjs");

async function withTempRepo(run) {
  const repo = await mkdtemp(join(tmpdir(), "local-ticket-checker-"));
  try {
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function writeFixture(repo, path, content) {
  const fullPath = join(repo, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  return fullPath;
}

function runChecker(repo, ticketPath) {
  const args = ticketPath === undefined ? [CLI] : [CLI, ticketPath];
  const result = spawnSync(process.execPath, args, {
    cwd: repo,
    encoding: "utf8",
  });
  return { ...result, json: JSON.parse(result.stdout) };
}

function assertEnvelope(result, ticketPath, ok) {
  assert.deepEqual(Object.keys(result.json).sort(), ["blockers", "errors", "ok", "ticket"]);
  assert.equal(result.json.ok, ok);
  assert.equal(result.json.ticket, ticketPath);
  assert.ok(Array.isArray(result.json.blockers));
  assert.ok(Array.isArray(result.json.errors));
}

test("validates the required metadata for a ready ticket with no blockers", async () => {
  await withTempRepo(async (repo) => {
    const validPath = ".scratch/example/issues/01-ready.md";
    const validContent = `# 01: Ready\n\nType: ticket\nParent: None\nStatus: ready-for-agent\nBlocked by: None\n`;
    const validFullPath = await writeFixture(repo, validPath, validContent);

    const valid = runChecker(repo, validPath);

    assert.equal(valid.status, 0);
    assertEnvelope(valid, validPath, true);
    assert.deepEqual(valid.json.blockers, []);
    assert.deepEqual(valid.json.errors, []);
    assert.equal(await readFile(validFullPath, "utf8"), validContent);

    const invalidFixtures = [
      [
        "02-spec.md",
        `# 02: Spec\n\nType: spec\nParent: None\nStatus: ready-for-agent\nBlocked by: None\n`,
        ["Type must be ticket"],
      ],
      [
        "03-wrong-status.md",
        `# 03: Wrong status\n\nType: ticket\nParent: None\nStatus: draft\nBlocked by: None\n`,
        ["Status must be ready-for-agent"],
      ],
      [
        "04-missing-type.md",
        `# 04: Missing type\n\nParent: None\nStatus: ready-for-agent\nBlocked by: None\n`,
        ["Type must be ticket"],
      ],
      [
        "05-missing-status.md",
        `# 05: Missing status\n\nType: ticket\nParent: None\nBlocked by: None\n`,
        ["Status must be ready-for-agent"],
      ],
      [
        "06-missing-blocked-by.md",
        `# 06: Missing blocked by\n\nType: ticket\nParent: None\nStatus: ready-for-agent\n`,
        ["Blocked by must be None"],
      ],
      [
        "07-has-blocker.md",
        `# 07: Has blocker\n\nType: ticket\nParent: None\nStatus: ready-for-agent\nBlocked by: .scratch/example/issues/00-blocker.md\n`,
        ["Blocker .scratch/example/issues/00-blocker.md could not be read"],
      ],
      [
        "08-missing-parent.md",
        `# 08: Missing parent\n\nType: ticket\nStatus: ready-for-agent\nBlocked by: None\n`,
        ["Parent is required"],
      ],
    ];

    for (const [name, content, expectedErrors] of invalidFixtures) {
      const ticketPath = `.scratch/example/issues/${name}`;
      await writeFixture(repo, ticketPath, content);
      const result = runChecker(repo, ticketPath);
      assert.equal(result.status, 1, name);
      assertEnvelope(result, ticketPath, false);
      assert.deepEqual(result.json.errors, expectedErrors, name);
    }
  });
});

test("treats Parent as a non-empty preflight field without dereferencing it", async () => {
  await withTempRepo(async (repo) => {
    const ticketPath = ".scratch/example/issues/01-parent-reference.md";
    const missingParentPath = ".scratch/example/missing-spec.md";
    await writeFixture(
      repo,
      ticketPath,
      `# 01: Parent preflight\n\nType: ticket\nParent: ${missingParentPath}\nStatus: ready-for-agent\nBlocked by: None\n`,
    );

    const result = runChecker(repo, ticketPath);

    assert.equal(result.status, 0);
    assertEnvelope(result, ticketPath, true);
    assert.deepEqual(result.json.errors, []);
  });
});

test("accepts a ready ticket whose blocker ticket is resolved", async () => {
  await withTempRepo(async (repo) => {
    const blockerPath = ".scratch/example/issues/01-resolved.md";
    const ticketPath = ".scratch/example/issues/02-ready.md";
    await writeFixture(
      repo,
      blockerPath,
      `# 01: Resolved\n\nType: ticket\nParent: .scratch/example/spec.md\nStatus: resolved\nBlocked by: None\n`,
    );
    await writeFixture(
      repo,
      ticketPath,
      `# 02: Ready\n\nType: ticket\nParent: .scratch/example/spec.md\nStatus: ready-for-agent\nBlocked by: ${blockerPath}\n`,
    );

    const result = runChecker(repo, ticketPath);

    assert.equal(result.status, 0);
    assertEnvelope(result, ticketPath, true);
    assert.deepEqual(result.json.blockers, [
      { ticket: blockerPath, type: "ticket", status: "resolved", ok: true },
    ]);
    assert.deepEqual(result.json.errors, []);
  });
});

test("reports missing, unresolved, and non-ticket blockers", async () => {
  await withTempRepo(async (repo) => {
    const fixtures = [
      {
        name: "missing",
        blockerPath: ".scratch/example/issues/00-missing.md",
        blockerContent: null,
        blocker: { type: null, status: null },
        error: "Blocker .scratch/example/issues/00-missing.md could not be read",
      },
      {
        name: "unresolved",
        blockerPath: ".scratch/example/issues/01-unresolved.md",
        blockerContent: `# 01: Unresolved\n\nType: ticket\nStatus: ready-for-agent\n`,
        blocker: { type: "ticket", status: "ready-for-agent" },
        error: "Blocker .scratch/example/issues/01-unresolved.md Status must be resolved",
      },
      {
        name: "spec",
        blockerPath: ".scratch/example/issues/01-spec.md",
        blockerContent: `# 01: Spec\n\nType: spec\nStatus: resolved\n`,
        blocker: { type: "spec", status: "resolved" },
        error: "Blocker .scratch/example/issues/01-spec.md Type must be ticket",
      },
    ];
    const results = [];

    for (const fixture of fixtures) {
      if (fixture.blockerContent !== null) {
        await writeFixture(repo, fixture.blockerPath, fixture.blockerContent);
      }
      const ticketPath = `.scratch/example/issues/02-${fixture.name}.md`;
      await writeFixture(
        repo,
        ticketPath,
        `# 02: Ready\n\nType: ticket\nParent: .scratch/example/spec.md\nStatus: ready-for-agent\nBlocked by: ${fixture.blockerPath}\n`,
      );
      results.push({ fixture, ticketPath, result: runChecker(repo, ticketPath) });
    }

    assert.deepEqual(
      results.map(({ result }) => result.status),
      [1, 1, 1],
    );
    assert.deepEqual(
      results.map(({ result }) => result.json.blockers),
      fixtures.map(({ blockerPath, blocker }) => [
        { ticket: blockerPath, ...blocker, ok: false },
      ]),
    );
    assert.deepEqual(
      results.map(({ result }) => result.json.errors),
      fixtures.map(({ error }) => [error]),
    );
    for (const { ticketPath, result } of results) {
      assertEnvelope(result, ticketPath, false);
    }
  });
});

test("accepts multiple resolved blockers in input order", async () => {
  await withTempRepo(async (repo) => {
    const blockerPaths = [
      ".scratch/example/issues/01-first.md",
      ".scratch/example/issues/02-second.md",
    ];
    for (const [index, blockerPath] of blockerPaths.entries()) {
      await writeFixture(
        repo,
        blockerPath,
        `# 0${index + 1}: Resolved\n\nType: ticket\nStatus: resolved\n`,
      );
    }
    const ticketPath = ".scratch/example/issues/03-ready.md";
    await writeFixture(
      repo,
      ticketPath,
      `# 03: Ready\n\nType: ticket\nParent: .scratch/example/spec.md\nStatus: ready-for-agent\nBlocked by: ${blockerPaths[0]},   ${blockerPaths[1]}\n`,
    );

    const result = runChecker(repo, ticketPath);

    assert.equal(result.status, 0);
    assertEnvelope(result, ticketPath, true);
    assert.deepEqual(
      result.json.blockers,
      blockerPaths.map((blockerPath) => ({
        ticket: blockerPath,
        type: "ticket",
        status: "resolved",
        ok: true,
      })),
    );
    assert.deepEqual(result.json.errors, []);
  });
});

test("rejects invalid blocker references without reading outside .scratch", async () => {
  await withTempRepo(async (repo) => {
    const outsideRepo = await mkdtemp(join(tmpdir(), "local-ticket-blocker-outside-"));
    const resolvedContent = `# 01: Resolved\n\nType: ticket\nStatus: resolved\n`;

    try {
      const absolutePath = await writeFixture(
        repo,
        ".scratch/example/issues/absolute.md",
        resolvedContent,
      );
      await writeFixture(repo, "outside-scratch.md", resolvedContent);
      const outsideFile = await writeFixture(outsideRepo, "outside-ticket.md", resolvedContent);
      const lexicalOutside = `.scratch/${relative(join(repo, ".scratch"), outsideFile)}`;
      const symlinkPath = ".scratch/example/issues/outside-link.md";
      const symlinkFullPath = join(repo, symlinkPath);
      await mkdir(dirname(symlinkFullPath), { recursive: true });
      await symlink(outsideFile, symlinkFullPath);

      const fixtures = [
        ["bare-number", "01"],
        ["title", "Resolved blocker"],
        ["absolute", absolutePath],
        ["outside-scratch", "outside-scratch.md"],
        ["lexical-outside", lexicalOutside],
        ["realpath-outside", symlinkPath],
        ["empty", ""],
      ];
      const results = [];

      for (const [name, blockerPath] of fixtures) {
        const ticketPath = `.scratch/example/issues/03-${name}.md`;
        await writeFixture(
          repo,
          ticketPath,
          `# 03: Ready\n\nType: ticket\nParent: .scratch/example/spec.md\nStatus: ready-for-agent\nBlocked by: ${blockerPath}\n`,
        );
        results.push({ blockerPath, ticketPath, result: runChecker(repo, ticketPath) });
      }

      assert.deepEqual(
        results.map(({ result }) => result.status),
        fixtures.map(() => 1),
      );
      assert.deepEqual(
        results.map(({ result }) => result.json.blockers),
        fixtures.map(([, blockerPath]) => [
          { ticket: blockerPath, type: null, status: null, ok: false },
        ]),
      );
      assert.deepEqual(
        results.map(({ result }) => result.json.errors),
        fixtures.map(([, blockerPath]) => [
          `Blocker ${JSON.stringify(blockerPath)} must be a repository-relative path under .scratch`,
        ]),
      );
      for (const { ticketPath, result } of results) {
        assertEnvelope(result, ticketPath, false);
      }
    } finally {
      await rm(outsideRepo, { recursive: true, force: true });
    }
  });
});

test("rejects metadata outside the continuous block after the ticket heading", async () => {
  await withTempRepo(async (repo) => {
    const fixtures = [
      [
        "metadata-in-body.md",
        `# 08: Metadata in body\n\n## What to build\n\nType: ticket\nStatus: ready-for-agent\nBlocked by: None\n`,
      ],
      [
        "metadata-in-code.md",
        `# 09: Metadata in code\n\n## What to build\n\n\`\`\`markdown\nType: ticket\nStatus: ready-for-agent\nBlocked by: None\n\`\`\`\n`,
      ],
    ];

    const results = [];
    for (const [name, content] of fixtures) {
      const ticketPath = `.scratch/example/issues/${name}`;
      await writeFixture(repo, ticketPath, content);
      results.push([name, ticketPath, runChecker(repo, ticketPath)]);
    }

    assert.deepEqual(
      results.map(([, , result]) => result.status),
      [1, 1],
    );
    for (const [name, ticketPath, result] of results) {
      assertEnvelope(result, ticketPath, false);
      assert.ok(result.json.errors.length > 0, name);
    }
  });
});

test("rejects paths that are not repo-relative files under .scratch", async () => {
  await withTempRepo(async (repo) => {
    const validContent = `# 11: Path boundary\n\nType: ticket\nParent: None\nStatus: ready-for-agent\nBlocked by: None\n`;
    const absolutePath = await writeFixture(repo, ".scratch/example/issues/absolute.md", validContent);
    await writeFixture(repo, "outside-scratch.md", validContent);
    const outsideRepo = await mkdtemp(join(tmpdir(), "local-ticket-checker-outside-"));

    try {
      const outsideFile = await writeFixture(outsideRepo, "outside-repo.md", validContent);
      const invalidPaths = [
        [absolutePath, ["Ticket path must be repository-relative"]],
        ["outside-scratch.md", ["Ticket path must be under .scratch"]],
        [".scratch/example/../../outside-scratch.md", ["Ticket path must be under .scratch"]],
        [relative(repo, outsideFile), ["Ticket path must be under .scratch"]],
      ];

      for (const [ticketPath, expectedErrors] of invalidPaths) {
        const result = runChecker(repo, ticketPath);
        assert.equal(result.status, 1, ticketPath);
        assertEnvelope(result, ticketPath, false);
        assert.deepEqual(result.json.errors, expectedErrors, ticketPath);
      }

      const missingArgument = runChecker(repo);
      assert.equal(missingArgument.status, 1);
      assertEnvelope(missingArgument, null, false);
      assert.deepEqual(missingArgument.json.errors, ["Ticket path must be repository-relative"]);
    } finally {
      await rm(outsideRepo, { recursive: true, force: true });
    }
  });
});

test("rejects a .scratch symlink whose real target is outside the repository", async () => {
  await withTempRepo(async (repo) => {
    const outsideRepo = await mkdtemp(join(tmpdir(), "local-ticket-checker-symlink-target-"));
    const ticketPath = ".scratch/example/issues/symlink.md";
    const validContent = `# 12: Symlink target\n\nType: ticket\nParent: None\nStatus: ready-for-agent\nBlocked by: None\n`;

    try {
      const outsideFile = await writeFixture(outsideRepo, "outside-ticket.md", validContent);
      const linkPath = join(repo, ticketPath);
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(outsideFile, linkPath);

      const result = runChecker(repo, ticketPath);

      assert.equal(result.status, 1);
      assertEnvelope(result, ticketPath, false);
      assert.deepEqual(result.json.errors, ["Ticket path must be under .scratch"]);
    } finally {
      await rm(outsideRepo, { recursive: true, force: true });
    }
  });
});
