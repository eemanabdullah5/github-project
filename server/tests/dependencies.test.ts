// Tests for the dependency scan: one reader per file type, the scan itself, and "no version" detection. No network.
import { describe, expect, it } from "vitest";
import {
  isUnpinned,
  parseRequirement,
  readGoMod,
  readPackageJson,
  readPomXml,
  readPyprojectToml,
  readRequirementsTxt,
  scanDependencies,
  type Dependency,
} from "../src/dependencies.js";

describe("parseRequirement (one Python requirement)", () => {
  it("reads names, versions, extras and conditions", () => {
    expect(parseRequirement("requests>=2.31,<3")).toEqual({ name: "requests", version: ">=2.31,<3" });
    expect(parseRequirement("uvicorn[standard]==0.30.1")).toEqual({ name: "uvicorn", version: "==0.30.1" });
    expect(parseRequirement("numpy ; python_version > '3.8'")).toEqual({ name: "numpy", version: "" });
    expect(parseRequirement("django (>=4.2)")).toEqual({ name: "django", version: ">=4.2" });
    expect(parseRequirement("mylib @ git+https://github.com/o/r.git")).toEqual({ name: "mylib", version: "from URL" });
  });
});

describe("readPackageJson", () => {
  it("reads runtime, peer, optional and dev dependencies", () => {
    const text = JSON.stringify({
      name: "app",
      dependencies: { express: "^5.1.0" },
      peerDependencies: { react: "^19.0.0" },
      optionalDependencies: { fsevents: "*" },
      devDependencies: { vitest: "^3.2.0" },
    });
    expect(readPackageJson(text)).toEqual([
      { name: "express", version: "^5.1.0", kind: "runtime" },
      { name: "react", version: "^19.0.0", kind: "runtime" },
      { name: "fsevents", version: "*", kind: "optional" },
      { name: "vitest", version: "^3.2.0", kind: "dev" },
    ]);
  });

  it("returns nothing for a package.json without dependencies", () => {
    expect(readPackageJson('{ "name": "x" }')).toEqual([]);
  });
});

describe("readRequirementsTxt", () => {
  it("skips comments, options, URLs and blank lines", () => {
    const text = ["# web", "flask==3.0.0  # pinned", "", "-r base.txt", "-e .", "--index-url https://x", "https://x/pkg.whl", "requests"].join("\n");
    expect(readRequirementsTxt(text, "requirements.txt")).toEqual([
      { name: "flask", version: "==3.0.0", kind: "runtime" },
      { name: "requests", version: "", kind: "runtime" },
    ]);
  });

  it("treats requirements-dev.txt as dev", () => {
    expect(readRequirementsTxt("pytest>=8", "requirements-dev.txt")[0].kind).toBe("dev");
  });
});

describe("readPyprojectToml", () => {
  it("reads PEP 621 dependencies, including arrays over several lines, and optional groups", () => {
    const text = `
[project]
name = "app"
dependencies = [
  "fastapi>=0.110",  # web
  "pydantic[email]==2.7",
]

[project.optional-dependencies]
test = ["pytest>=8"]
postgres = ["psycopg>=3"]

[tool.ruff]
line-length = 100
`;
    expect(readPyprojectToml(text)).toEqual([
      { name: "fastapi", version: ">=0.110", kind: "runtime" },
      { name: "pydantic", version: "==2.7", kind: "runtime" },
      { name: "pytest", version: ">=8", kind: "dev" },
      { name: "psycopg", version: ">=3", kind: "optional" },
    ]);
  });

  it("reads Poetry dependencies and skips python itself", () => {
    const text = `
[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.31"
redis = { version = "^5.0", optional = true }

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"
`;
    expect(readPyprojectToml(text)).toEqual([
      { name: "requests", version: "^2.31", kind: "runtime" },
      { name: "redis", version: "^5.0", kind: "optional" },
      { name: "pytest", version: "^8.0", kind: "dev" },
    ]);
  });
});

describe("readGoMod", () => {
  it("reads single requires and require blocks, marking indirect ones", () => {
    const text = `module example.com/app

go 1.22

require github.com/gin-gonic/gin v1.9.1

require (
	github.com/stretchr/testify v1.9.0
	golang.org/x/text v0.14.0 // indirect
)
`;
    expect(readGoMod(text)).toEqual([
      { name: "github.com/gin-gonic/gin", version: "v1.9.1", kind: "runtime" },
      { name: "github.com/stretchr/testify", version: "v1.9.0", kind: "runtime" },
      { name: "golang.org/x/text", version: "v0.14.0", kind: "indirect" },
    ]);
  });
});

describe("readPomXml", () => {
  it("reads dependencies, fills in properties, and skips managed versions and build plugins", () => {
    const text = `<project>
  <properties><slf4j.version>2.0.13</slf4j.version></properties>
  <dependencyManagement><dependencies>
    <dependency><groupId>x</groupId><artifactId>managed-only</artifactId><version>1</version></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>\${slf4j.version}</version></dependency>
    <!-- <dependency><groupId>old</groupId><artifactId>commented-out</artifactId></dependency> -->
    <dependency><groupId>org.junit</groupId><artifactId>junit</artifactId><version>5.10.0</version><scope>test</scope></dependency>
    <dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId></dependency>
  </dependencies>
  <build><plugins><plugin><dependencies>
    <dependency><groupId>p</groupId><artifactId>plugin-dep</artifactId><version>1</version></dependency>
  </dependencies></plugin></plugins></build>
</project>`;
    expect(readPomXml(text)).toEqual([
      { name: "org.slf4j:slf4j-api", version: "2.0.13", kind: "runtime" },
      { name: "org.junit:junit", version: "5.10.0", kind: "dev" },
      { name: "org.springframework:spring-core", version: "managed", kind: "runtime" },
    ]);
  });
});

describe("scanDependencies", () => {
  const file = (path: string, text: string) => ({ path, text, language: "text" });

  it("reads every dependency file it recognises, and ignores other files", () => {
    const scan = scanDependencies(
      [
        file("web/package.json", '{ "dependencies": { "react": "^19.0.0" } }'),
        file("api/requirements.txt", "flask==3.0.0"),
        file("src/app.ts", "import x from 'y'"),
        file("docs/requirements-notes.md", "requests"),
      ],
      { repoId: "o/r", commitSha: "abc" },
    );
    expect(scan.files).toEqual([
      { path: "api/requirements.txt", ecosystem: "pip", count: 1 },
      { path: "web/package.json", ecosystem: "npm", count: 1 },
    ]);
    expect(scan.dependencies).toEqual([
      { name: "flask", version: "==3.0.0", kind: "runtime", ecosystem: "pip", file: "api/requirements.txt" },
      { name: "react", version: "^19.0.0", kind: "runtime", ecosystem: "npm", file: "web/package.json" },
    ]);
  });

  it("lists a broken file with its error instead of stopping the scan", () => {
    const scan = scanDependencies([file("package.json", "{ not json"), file("go.mod", "require a.com/b v1.0.0")], { repoId: "o/r", commitSha: "abc" });
    expect(scan.files[0]).toMatchObject({ path: "go.mod", count: 1 });
    expect(scan.files[1]).toMatchObject({ path: "package.json", count: 0 });
    expect(scan.files[1].error).toBeTruthy();
  });
});

describe("isUnpinned", () => {
  const dep = (version: string, ecosystem: Dependency["ecosystem"] = "npm"): Dependency => ({ name: "x", version, ecosystem, kind: "runtime", file: "f" });

  it("flags missing, * and latest versions, but not ranges, managed or Go versions", () => {
    expect(isUnpinned(dep(""))).toBe(true);
    expect(isUnpinned(dep("*"))).toBe(true);
    expect(isUnpinned(dep("latest"))).toBe(true);
    expect(isUnpinned(dep("^5.1.0"))).toBe(false);
    expect(isUnpinned(dep("managed", "maven"))).toBe(false);
    expect(isUnpinned(dep("from URL", "pip"))).toBe(false);
  });
});
