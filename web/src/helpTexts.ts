// Every ⓘ help text in the app, in one place. Edit the wording here; the components only show it.
// A line break (\n) starts a new line in the help box.

export const HELP = {
  // Hotspots tab
  hotspots: {
    oneContributor:
      "Top-level folders only one person changed in the analysed commits. If they're away or leave, nobody else knows that code well (the 'bus factor').",
    topHotspots:
      "Hotspot score = how often a file changes × how complex it is. The top hotspot is 100. It shows where to look first, not a measured bug risk.\nComplexity = the cognitive complexity of the file's most complex function: each if, loop, catch or \"? :\" adds 1, plus 1 more for each level it's nested. ≈ means estimated (no parser for that language).",
    allFiles:
      "Every file changed in the analysed commits that still exists. Changes = how many commits touched it. Complexity = how hard its most complex function is to follow (more nesting and branches = higher). Files high on both are the hotspots.",
    changeTogether:
      "Pairs of files often changed in the same commit. This can mean a hidden dependency between them. The percentage is how often the less-changed file changed together with the other.",
    knowledgeRisk:
      "How many different people changed each top-level folder. A folder only one or two people have worked on depends on them; code reviews and pairing spread that knowledge and lower the risk. No names are shown or stored.",
  },
  // Architecture tab
  architecture: {
    moduleCycles:
      "Groups of folders that import each other in a loop (A uses B, and B uses A). Loops make code harder to change, test and split up.",
    fileCycles:
      "Files that import each other in a loop, directly or through other files. A change to one can affect the others, and they can load in the wrong order.",
    hiddenCoupling:
      "Code files that keep changing in the same commit but don't import each other. Something the code doesn't show ties them together, such as copied logic or a shared data format, so changing only one side can break the other.",
    moduleMap:
      "Each box is a folder of code. An arrow points from the folder that imports to the folder it uses; the number on it is how many imports it stands for.",
    cycles:
      "Code that depends on itself in a loop is harder to change, test and split up. Loops between a folder and its own subfolder are common; loops between unrelated folders are more worrying.",
    modules:
      "\"Used by\" counts the other folders that depend on this one: the higher it is, the more a change here can affect.",
  },
  // Calls tab
  calls: {
    callsMatched:
      "Calls where the code shows exactly which function is called: one in the same file, an imported one, or a method of a known class.",
    possibleCalls:
      "Method calls like obj.save() where the code doesn't say what obj is. They're matched by method name, so some may be wrong. Shown as dashed arrows.",
    diagram:
      "Left: the functions that call it. Right: the functions it calls. Arrows point from the caller to the function it calls. With “2 steps”, it also shows who calls the callers and what the callees call.",
  },
  // Calls tab: change impact section
  impact: {
    section:
      "Everything that calls this function, directly or through other functions, and the tests that reach it. Use it before a change to see how far it spreads and whether tests would catch a mistake.",
    furthest:
      "How many calls separate this function from the furthest code that depends on it. More steps means a change travels further through the code.",
    affected:
      "Functions in your code that call this one, directly or through other functions. If this function's behaviour changes, these may behave differently too. Grouped by how many calls away they are.",
    tests:
      "Tests that end up running this function, directly or through other functions. If there are none, running the tests won't catch a mistake here.",
    files:
      "The files the affected functions are in, plus this function's own file. Hotspots (files that change often and are complex, from the Hotspots tab) come first.",
  },
  // PR risk tab
  pr: {
    risk:
      "Each rule that applies adds points, shown with its reason. 0–2 points = low, 3–5 = medium, 6 or more = high.\nRules: size (+1 over 200 lines, +2 over 500) · spread (+1 if 8+ functions depend on the changes, +2 if 25+) · changed functions no test reaches (+2) · code changed without test files (+1) · hotspot files (+1, +2 for a top hotspot) · a file that usually changes with these is missing (+1) · code only one person knows (+1) · a function gets much harder to follow (+1 if its complexity rises by 5+ or a new one is 10+; +2 if it reaches 25+).",
    changedFunctions:
      "Functions whose lines this PR adds, changes or deletes, found by matching the diff to the PR's own code. Affected = how many other functions depend on it; tests = how many tests reach it; complexity = how hard it is to follow, before → after this PR (red when it rose by 5 or more).",
    affected:
      "Other functions that depend on the changed code, directly or through other functions. Functions changed in the PR itself aren't counted.",
    untested:
      "Changed functions that no test reaches, directly or through other functions. A mistake in them wouldn't be caught by the test suite.",
    partners:
      "Files that changed together with a changed file in at least half of its past commits, but aren't in this PR. Worth checking that nothing was forgotten.",
    reviewers:
      "People who recently changed the PR's busiest files, so they likely know that code. The PR author and bots are left out. Nothing is stored.",
    files: "Every file the PR changes. Hotspot = a file that changes often and is complex (from the Hotspots tab). No diff = GitHub didn't send the changes (binary or very large).",
  },
};
