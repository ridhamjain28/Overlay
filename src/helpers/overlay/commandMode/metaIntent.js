// Questions and complaints about a previous command must stay in explanation
// mode. They are never a new search or another desktop action.

function trimText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function looksLikeFreshCommand(text) {
  const t = trimText(text);
  if (!t) return false;
  if (/\b(you|u)\s+opened\b/i.test(t) && /\bbut\b/i.test(t)) return false;
  if (
    /^(open|launch|start|go to|goto|visit|kholo|chalao|find|locate|add|create|schedule|compose|write|type|search for)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function isMetaIntent(text) {
  const t = trimText(text);
  if (!t) return false;
  if (looksLikeFreshCommand(t) && !/\b(you|u)\s+(opened|did|failed|couldn't|could not)\b/i.test(t)) {
    return false;
  }
  if (/\b(you|u)\s+opened\b[\s\S]*\bbut\b/i.test(t)) return true;
  if (/\b(what happened|what went wrong|what's wrong|whats wrong)\b/i.test(t)) return true;
  if (/\b(why|y)\s+(did|didn't|did not|couldn't|could not|would)\s+(you|u|it)\b/i.test(t)) return true;
  if (/\b(y did u|why did you|why'd you|why did it)\b/i.test(t)) return true;
  if (/\b(did you|did u)\s+fail\b/i.test(t)) return true;
  if (/\b(you|u|it|that|this)\s+(failed|fail)\b/i.test(t)) return true;
  if (/\b(couldn't|could not|couldnt|didn't|did not)\s+(search|open|find|save|do it)\b/i.test(t) &&
      /\b(why|y|fail|but|you|u)\b/i.test(t)) {
    return true;
  }
  if (/\b(didn't work|did not work|does(?:n'?t)? work|not working)\b/i.test(t)) return true;
  if (/^(why|what happened)\b/i.test(t)) return true;
  return false;
}

function describeStep(step, result) {
  const action = (result && result.action) || step?.action || "";
  const args = (result && result.args) || step?.args || {};
  if (action === "open_app") return `opened ${args.app || args.label || "the app"}`;
  if (action === "open_url") {
    const url = args.url || "";
    if (/google\.[^/]+\/search\?/i.test(url)) return "opened a web search";
    if (/calendar\.google\.com/i.test(url)) return "opened a calendar event";
    return `opened ${url || "a link"}`;
  }
  if (action === "find_path") {
    const name = args.name || "that item";
    const n = Array.isArray(result?.matches) ? result.matches.length : null;
    if (n === 0) return `looked for "${name}" and didn't find it`;
    if (n === 1) return `found "${name}" at ${result.matches[0].path}`;
    if (n > 1) return `found ${n} places named "${name}"`;
    return `searched for "${name}"`;
  }
  if (action === "open_path") return `opened ${args.path || "the path"}`;
  if (action === "submit_page") return result?.success === false ? "couldn't save it" : "tried to save it";
  if (action === "compose_text") return "started writing";
  return action ? `ran ${action}` : "ran a step";
}

function formatMetaExplanation(text, last) {
  if (!last || !last.handled) {
    return "I don't have a previous command to go over. What would you like me to do?";
  }
  const steps = last.steps || [];
  const results = last.results || [];
  const parts = [];
  if (steps.length) {
    const bits = steps.map((step, i) => describeStep(step, results[i]));
    parts.push(`Last time I ${bits.join(", then ")}.`);
  } else if (last.message) {
    parts.push(last.message);
  }
  const failed = results.find((row) => row && row.success === false);
  if (failed) {
    const err = failed.message || failed.error || "";
    if (/explorer\.exe/i.test(err) && /command failed/i.test(err)) {
      parts.push(
        "Explorer often returns a failure code even when the window opened, so I reported a failure by mistake. If a search didn't happen, I can do that next."
      );
    } else if (err) {
      parts.push(`That ended with: ${err.replace(/^Action failed:\s*/i, "")}`);
    }
  } else if (last.success) {
    parts.push("That command finished.");
  }
  parts.push("I can retry it if you want, or tell me what to search for.");
  return parts.filter(Boolean).join(" ");
}

module.exports = {
  isMetaIntent,
  looksLikeFreshCommand,
  formatMetaExplanation,
};
