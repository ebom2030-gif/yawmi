var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/index.js
var GAS = "https://script.google.com/macros/s/AKfycbwgvjkn2Op3hg-sSwxMi3PJO4MmIot0udoa8FXKOGTK9LBjqKuGtqlLYY1FaAkMwnI9/exec";
var FULL_SYNC_MIN = 20;
var H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-yw-gw": "1" };
var SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, owner TEXT, space TEXT, due TEXT, done INTEGER DEFAULT 0, title TEXT, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS projects (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, name TEXT, status TEXT, space TEXT, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS contacts (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, name TEXT, cat TEXT, space TEXT, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS users (tn TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, username TEXT, name TEXT, role TEXT, active INTEGER, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (tn, id))`,
  `CREATE TABLE IF NOT EXISTS notes (tn TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL, date TEXT NOT NULL, text TEXT, updated_at INTEGER, PRIMARY KEY (tn, owner, date))`,
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sess (th TEXT PRIMARY KEY, tn TEXT, uid TEXT, full_at INTEGER, seen_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sync_log (at INTEGER, tn TEXT, uid TEXT, fn TEXT, ok INTEGER, ms INTEGER, err TEXT)`,
  `CREATE INDEX IF NOT EXISTS items_owner ON items (tn, owner)`
];
var ready = false;
async function init(db) {
  if (ready) return;
  await db.batch(SCHEMA.map((q) => db.prepare(q)));
  ready = true;
}
__name(init, "init");
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(sha, "sha");
var J = /* @__PURE__ */ __name((v) => JSON.stringify(v ?? null), "J");
async function mirror(env, req, res, ms) {
  const db = env.DB;
  if (!db) return;
  const { t, fn, args = [] } = req;
  const now = Date.now();
  try {
    await init(db);
    const th = t ? await sha("yw|" + t) : "";
    if (fn === "logout") {
      if (th) await db.prepare("DELETE FROM sess WHERE th = ?").bind(th).run();
      return;
    }
    let s = th ? await db.prepare("SELECT tn, uid, full_at FROM sess WHERE th = ?").bind(th).first() : null;
    const S = [];
    if (fn === "getAll" && res && res.me) {
      const tn = res.ten && res.ten.id || "", uid = res.me.id;
      S.push(db.prepare("INSERT INTO sess (th, tn, uid, full_at, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(th) DO UPDATE SET tn = excluded.tn, uid = excluded.uid, seen_at = excluded.seen_at").bind(th, tn, uid, s ? s.full_at || 0 : 0, now));
      if (!s || !s.full_at || now - s.full_at > FULL_SYNC_MIN * 6e4) {
        S.push(db.prepare("UPDATE sess SET full_at = ? WHERE th = ?").bind(now, th));
        if (res.ten) S.push(db.prepare("INSERT INTO tenants (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").bind(tn, J(res.ten), now));
        (res.items || []).forEach((o) => o && o.id && S.push(upItem(db, tn, o, now)));
        (res.projects || []).filter((p) => p && p.id && !p._nofin).forEach((p) => S.push(upProj(db, tn, p, now)));
        (res.contacts || []).forEach((c) => c && c.id && S.push(upCont(db, tn, c, now)));
        (res.users || []).forEach((u) => u && u.id && S.push(db.prepare("INSERT INTO users (tn, id, username, name, role, active, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET username = excluded.username, name = excluded.name, role = excluded.role, active = excluded.active, data = excluded.data, updated_at = excluded.updated_at").bind(tn, u.id, u.username || "", u.name || "", u.role || "", u.active === false ? 0 : 1, J(u), now)));
        Object.entries(res.notes || {}).forEach(([d, x]) => S.push(upNote(db, tn, uid, d, x, now)));
      }
    } else if (s) {
      const tn = s.tn || "";
      if (fn === "saveItem" && args[0] && args[0].id) S.push(upItem(db, tn, args[0], now));
      else if (fn === "deleteItem" && args[0]) S.push(db.prepare("DELETE FROM items WHERE tn = ? AND id = ?").bind(tn, String(args[0])));
      else if (fn === "saveProject" && args[0] && args[0].id && !args[0]._nofin) S.push(upProj(db, tn, Object.assign({}, args[0], { updatedAt: res && res.updatedAt || now }), now));
      else if (fn === "deleteProject" && args[0]) S.push(db.prepare("DELETE FROM projects WHERE tn = ? AND id = ?").bind(tn, String(args[0])));
      else if (fn === "saveContact" && args[0] && args[0].id) S.push(upCont(db, tn, args[0], now));
      else if (fn === "deleteContact" && args[0]) S.push(db.prepare("DELETE FROM contacts WHERE tn = ? AND id = ?").bind(tn, String(args[0])));
      else if (fn === "saveNote" && args[0]) S.push(upNote(db, tn, s.uid, String(args[0]), args[1], now));
    }
    if (!S.length) return;
    S.push(db.prepare("INSERT INTO sync_log (at, tn, uid, fn, ok, ms, err) VALUES (?, ?, ?, ?, 1, ?, NULL)").bind(now, s ? s.tn : res && res.ten && res.ten.id || "", s ? s.uid : res && res.me && res.me.id || "", fn, ms));
    for (let i = 0; i < S.length; i += 90) await db.batch(S.slice(i, i + 90));
  } catch (e) {
    try {
      await db.prepare("INSERT INTO sync_log (at, tn, uid, fn, ok, ms, err) VALUES (?, ?, ?, ?, 0, ?, ?)").bind(now, "", "", fn, ms, String(e && e.message || e).slice(0, 400)).run();
    } catch (x) {
    }
  }
}
__name(mirror, "mirror");
var upItem = /* @__PURE__ */ __name((db, tn, o, now) => db.prepare("INSERT INTO items (tn, id, owner, space, due, done, title, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET owner = excluded.owner, space = excluded.space, due = excluded.due, done = excluded.done, title = excluded.title, data = excluded.data, updated_at = excluded.updated_at").bind(tn, String(o.id), o.owner || "", o.space || "", o.due || "", o.done ? 1 : 0, String(o.title || "").slice(0, 300), J(o), now), "upItem");
var upProj = /* @__PURE__ */ __name((db, tn, p, now) => db.prepare("INSERT INTO projects (tn, id, name, status, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET name = excluded.name, status = excluded.status, space = excluded.space, data = excluded.data, updated_at = excluded.updated_at").bind(tn, String(p.id), p.name || "", p.status || "", p.space || "", J(p), now), "upProj");
var upCont = /* @__PURE__ */ __name((db, tn, c, now) => db.prepare("INSERT INTO contacts (tn, id, name, cat, space, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tn, id) DO UPDATE SET name = excluded.name, cat = excluded.cat, space = excluded.space, data = excluded.data, updated_at = excluded.updated_at").bind(tn, String(c.id), c.name || "", c.cat || "", c.space || "", J(c), now), "upCont");
var upNote = /* @__PURE__ */ __name((db, tn, uid, d, x, now) => db.prepare("INSERT INTO notes (tn, owner, date, text, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tn, owner, date) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at").bind(tn, uid || "", d, String(x ?? ""), now), "upNote");
async function onRequestPost({ request, env, waitUntil }) {
  const body = await request.text();
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(env.GAS_URL || GAS, { method: "POST", body, redirect: "follow", headers: { "content-type": "text/plain;charset=utf-8" } });
  } catch (e) {
    return new Response(J({ ok: false, error: "\u062A\u0639\u0630\u0651\u0631 \u0627\u0644\u0627\u062A\u0635\u0627\u0644 \u0628\u0627\u0644\u062E\u0627\u062F\u0645 \u2014 \u062D\u0627\u0648\u0644 \u0645\u0631\u0629 \u0623\u062E\u0631\u0649" }), { status: 502, headers: H });
  }
  const text = await r.text();
  if (!r.ok || text.charAt(0) !== "{") return new Response(J({ ok: false, error: "\u062E\u0637\u0623 \u0641\u064A \u0627\u0644\u0627\u062A\u0635\u0627\u0644 \u0628\u0627\u0644\u062E\u0627\u062F\u0645 (" + r.status + ")" }), { status: 502, headers: H });
  if (env.DB) waitUntil((async () => {
    let req, out;
    try {
      req = JSON.parse(body);
      out = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (out && out.ok) await mirror(env, req, out.data, Date.now() - t0);
  })());
  return new Response(text, { headers: H });
}
__name(onRequestPost, "onRequestPost");
async function onRequestGet({ request, env }) {
  const o = { ok: true, gateway: true, d1: !!env.DB };
  const t = new URL(request.url).searchParams.get("t");
  if (env.DB) {
    try {
      await init(env.DB);
      o.lastSync = (await env.DB.prepare("SELECT MAX(at) n FROM sync_log WHERE ok = 1").first()).n;
      const s = t ? await env.DB.prepare("SELECT tn FROM sess WHERE th = ?").bind(await sha("yw|" + t)).first() : null;
      if (s) {
        const c = /* @__PURE__ */ __name(async (q) => (await env.DB.prepare(q).bind(s.tn).first()).n, "c");
        Object.assign(o, { items: await c("SELECT COUNT(*) n FROM items WHERE tn = ?"), projects: await c("SELECT COUNT(*) n FROM projects WHERE tn = ?"), contacts: await c("SELECT COUNT(*) n FROM contacts WHERE tn = ?"), users: await c("SELECT COUNT(*) n FROM users WHERE tn = ?"), errors24h: (await env.DB.prepare("SELECT COUNT(*) n FROM sync_log WHERE ok = 0 AND at > ?").bind(Date.now() - 864e5).first()).n });
      }
    } catch (e) {
      o.err = String(e.message || e);
    }
  }
  return new Response(J(o), { headers: H });
}
__name(onRequestGet, "onRequestGet");

// ../.wrangler/tmp/pages-blUgOY/functionsRoutes-0.9554530821394589.mjs
var routes = [
  {
    routePath: "/api",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/api",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  }
];

// ../../ywtest/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../ywtest/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init2) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init2);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");

// ../../ywtest/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../ywtest/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// ../.wrangler/tmp/bundle-ReS4D1/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;

// ../../ywtest/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// ../.wrangler/tmp/bundle-ReS4D1/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init2) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init2.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init2) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init2.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=functionsWorker-0.8368749417390637.mjs.map
