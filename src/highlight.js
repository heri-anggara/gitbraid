/* Syntax colouring for diff lines. Exposed as window.Hl.
 *
 * A diff shows fragments: one line of a template literal, half a block comment,
 * the middle of a JSX attribute list. A real parser needs the whole file and
 * gets confused by fragments, so this works the way every diff viewer does —
 * pattern by pattern, one line at a time, and it never throws. Anything it
 * cannot classify is simply left plain.
 */
(function () {
  'use strict';

  const esc = (s) =>
    s.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const words = (list) => new Set(list.split(/\s+/).filter(Boolean));

  const JS_KEYWORDS = words(`
    abstract as async await break case catch class const continue debugger declare
    default delete do else enum export extends finally for from function get if
    implements import in infer instanceof interface is keyof let module namespace
    new of package private protected public readonly return satisfies set static
    super switch symbol this throw try type typeof unique unknown var void while
    with yield`);
  const JS_LITERALS = words('true false null undefined NaN Infinity');
  const JS_TYPES = words(`
    string number boolean object any never bigint Array Promise Record Partial
    Pick Omit Map Set Date RegExp Error React JSX`);

  const PY_KEYWORDS = words(`
    and as assert async await break class continue def del elif else except
    finally for from global if import in is lambda nonlocal not or pass raise
    return try while with yield match case`);
  const PY_LITERALS = words('True False None self cls');

  const SH_KEYWORDS = words(`
    if then else elif fi for while until do done case esac function return
    local export set unset shift echo cd exit source read trap`);

  const SQL_KEYWORDS = words(`
    select from where insert into values update set delete create table alter
    drop index view join left right inner outer on group by order having limit
    offset union all as distinct and or not null is in like between case when
    then else end primary key foreign references default constraint unique
    begin commit rollback transaction with returning`);

  const GO_KEYWORDS = words(`
    break case chan const continue default defer else fallthrough for func go
    goto if import interface map package range return select struct switch type
    var nil true false iota error string int int64 float64 bool byte rune`);

  const RS_KEYWORDS = words(`
    as async await break const continue crate dyn else enum extern false fn for
    if impl in let loop match mod move mut pub ref return self Self static struct
    super trait true type unsafe use where while String Vec Option Result Some
    None Ok Err`);

  /* Ruby and PHP were being coloured by tables meant for other languages —
     Ruby by Python's, PHP by JavaScript's — which got their strings, numbers and
     comments right and their keywords wrong. `end`, `unless` and `elsif` are
     most of what Ruby looks like, and none of them were coloured. */
  const RB_KEYWORDS = words(`
    alias and begin break case class def defined? do else elsif end ensure for
    if in module next not or redo rescue retry return self super then undef
    unless until when while yield lambda proc require require_relative include
    extend attr_accessor attr_reader attr_writer raise`);
  const RB_LITERALS = words('true false nil __FILE__ __LINE__');

  const PHP_KEYWORDS = words(`
    abstract and array as break callable case catch class clone const continue
    declare default do echo else elseif empty enddeclare endfor endforeach endif
    endswitch endwhile enum extends final finally fn for foreach function global
    goto if implements include include_once instanceof insteadof interface isset
    list match namespace new or print private protected public readonly require
    require_once return static switch throw trait try unset use var while xor
    yield`);
  const PHP_LITERALS = words('true false null this parent self');
  const PHP_TYPES = words(`
    bool int float string object mixed void never iterable callable Closure
    Exception Throwable ArrayAccess Countable Iterator Generator`);

  /* Each entry is tried in order at the current position. `re` must be sticky. */
  const clike = (keywords, literals, types, lineComment) => [
    { cls: 'hl-com', re: new RegExp(`${lineComment}.*`, 'y') },
    { cls: 'hl-com', re: /\/\*[\s\S]*?(?:\*\/|$)/y },
    { cls: 'hl-com', re: /\*\/|^\s*\*(?!\/)/y },          // middle of a block comment
    { cls: 'hl-str', re: /`(?:\\.|[^`\\])*`?/y },
    { cls: 'hl-str', re: /"(?:\\.|[^"\\])*"?/y },
    { cls: 'hl-str', re: /'(?:\\.|[^'\\])*'?/y },
    { cls: 'hl-num', re: /\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b/y },
    { cls: 'hl-tag', re: /<\/?[A-Z][\w.]*|<\/?[a-z][\w-]*(?=[\s/>])/y },
    { cls: 'hl-fn',  re: /\b[A-Za-z_$][\w$]*(?=\s*\()/y },
    { word: true,    re: /\b[A-Za-z_$][\w$]*\b/y, keywords, literals, types },
    { cls: 'hl-op',  re: /[=+\-*/%!<>&|^~?:]+/y },
    { cls: null,     re: /\s+|[\s\S]/y },
  ];

  const LANGS = {
    js: clike(JS_KEYWORDS, JS_LITERALS, JS_TYPES, '//'),
    /* Ruby comments with #, and its block form is =begin/=end rather than the
       C one — but that never appears mid-line, so the C rules cost nothing. */
    ruby: clike(RB_KEYWORDS, RB_LITERALS, words('Integer String Symbol Hash Array Float Struct Comparable Enumerable'), '#'),
    // PHP takes both // and #, and $variables fall through as ordinary words.
    php: clike(PHP_KEYWORDS, PHP_LITERALS, PHP_TYPES, '(?://|#)'),
    json: [
      { cls: 'hl-prop', re: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
      { cls: 'hl-str', re: /"(?:\\.|[^"\\])*"?/y },
      { cls: 'hl-num', re: /-?\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
      { cls: 'hl-lit', re: /\b(?:true|false|null)\b/y },
      { cls: null, re: /\s+|[\s\S]/y },
    ],
    css: [
      { cls: 'hl-com', re: /\/\*[\s\S]*?(?:\*\/|$)|\*\//y },
      { cls: 'hl-str', re: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/y },
      { cls: 'hl-key', re: /@[\w-]+/y },
      { cls: 'hl-prop', re: /[-a-zA-Z]+(?=\s*:)/y },
      { cls: 'hl-num', re: /#[0-9a-fA-F]{3,8}\b|-?\b\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms|fr|deg)?\b/y },
      { cls: 'hl-tag', re: /\.[-\w]+|#[-\w]+|&|:{1,2}[-\w()]+/y },
      { cls: null, re: /\s+|[\s\S]/y },
    ],
    html: [
      { cls: 'hl-com', re: /<!--[\s\S]*?(?:-->|$)|-->/y },
      { cls: 'hl-tag', re: /<\/?[\w:-]+|\/?>/y },
      { cls: 'hl-str', re: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/y },
      { cls: 'hl-attr', re: /\b[\w:-]+(?==)/y },
      { cls: null, re: /\s+|[\s\S]/y },
    ],
    md: [
      { cls: 'hl-key', re: /^#{1,6}\s.*/y },
      { cls: 'hl-str', re: /`[^`]*`?|```.*/y },
      { cls: 'hl-tag', re: /\[[^\]]*\]\([^)]*\)?/y },
      { cls: 'hl-lit', re: /\*\*[^*]+\*\*|\*[^*]+\*|^\s*[-*+]\s|^\s*\d+\.\s/y },
      { cls: null, re: /\s+|[\s\S]/y },
    ],
    sh: [
      { cls: 'hl-com', re: /#.*/y },
      { cls: 'hl-str', re: /"(?:\\.|[^"\\])*"?|'[^']*'?/y },
      { cls: 'hl-prop', re: /\$\{?[\w@#?*!-]+\}?/y },
      { word: true, re: /\b[A-Za-z_][\w-]*\b/y, keywords: SH_KEYWORDS, literals: words(''), types: words('') },
      { cls: 'hl-num', re: /\b\d+\b/y },
      { cls: null, re: /\s+|[\s\S]/y },
    ],
    py: [
      { cls: 'hl-com', re: /#.*/y },
      { cls: 'hl-str', re: /[rbfu]{0,2}("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?)/y },
      { cls: 'hl-attr', re: /@[\w.]+/y },
      { cls: 'hl-num', re: /\b\d[\d_]*(?:\.\d+)?\b/y },
      { cls: 'hl-fn', re: /\b[A-Za-z_]\w*(?=\s*\()/y },
      { word: true, re: /\b[A-Za-z_]\w*\b/y, keywords: PY_KEYWORDS, literals: PY_LITERALS, types: words('') },
      { cls: null, re: /\s+|[\s\S]/y },
    ],
    sql: [
      { cls: 'hl-com', re: /--.*|\/\*[\s\S]*?(?:\*\/|$)/y },
      { cls: 'hl-str', re: /'(?:''|[^'])*'?/y },
      { cls: 'hl-num', re: /\b\d+(?:\.\d+)?\b/y },
      { word: true, re: /\b[A-Za-z_]\w*\b/y, keywords: SQL_KEYWORDS, literals: words('null true false'),
        types: words('int integer text varchar boolean timestamp date decimal numeric serial uuid jsonb'),
        fold: true },
      { cls: null, re: /\s+|[\s\S]/y },
    ],
    yaml: [
      { cls: 'hl-com', re: /#.*/y },
      { cls: 'hl-prop', re: /^\s*-?\s*[\w.$-]+(?=\s*:)/y },
      { cls: 'hl-str', re: /"(?:\\.|[^"\\])*"?|'[^']*'?/y },
      { cls: 'hl-lit', re: /\b(?:true|false|null|yes|no)\b/y },
      { cls: 'hl-num', re: /\b\d[\d_]*(?:\.\d+)?\b/y },
      { cls: null, re: /\s+|[\s\S]/y },
    ],
    go: clike(GO_KEYWORDS, words('nil true false iota'), words(''), '//'),
    rust: clike(RS_KEYWORDS, words('true false None Some Ok Err'), words(''), '//'),
  };

  const BY_EXT = {
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', vue: 'html',
    json: 'json', jsonc: 'json',
    css: 'css', scss: 'css', sass: 'css', less: 'css',
    html: 'html', htm: 'html', svg: 'html', xml: 'html', pug: 'html',
    md: 'md', markdown: 'md',
    sh: 'sh', bash: 'sh', zsh: 'sh', env: 'sh',
    py: 'py', sql: 'sql',
    yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml',
    go: 'go', rs: 'rust',
    c: 'js', h: 'js', cpp: 'js', hpp: 'js', java: 'js', kt: 'js', swift: 'js',
    php: 'php', phtml: 'php', rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
    cs: 'js', dart: 'js',
  };

  /** Which pattern table fits this path, or null when nothing does. */
  function langOf(pathName) {
    const base = String(pathName || '').split('/').pop() || '';
    if (/^(Dockerfile|Makefile)/i.test(base)) return 'sh';
    const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
    return BY_EXT[ext] || null;
  }

  /** Escaped HTML for one line, wrapped in spans. Never throws. */
  function line(text, lang) {
    const rules = LANGS[lang];
    const src = String(text ?? '');
    if (!rules) return esc(src);

    let out = '';
    let i = 0;
    let guard = 0;
    while (i < src.length && guard++ < 4000) {
      let matched = false;
      for (const rule of rules) {
        rule.re.lastIndex = i;
        const m = rule.re.exec(src);
        if (!m || m.index !== i || m[0] === '') continue;

        if (rule.word) {
          const w = m[0];
          const probe = rule.fold ? w.toLowerCase() : w;
          const cls =
            rule.keywords.has(probe) ? 'hl-key' :
            rule.literals.has(probe) ? 'hl-lit' :
            rule.types.has(probe) ? 'hl-type' : null;
          out += cls ? `<span class="${cls}">${esc(w)}</span>` : esc(w);
        } else {
          out += rule.cls ? `<span class="${rule.cls}">${esc(m[0])}</span>` : esc(m[0]);
        }
        i += m[0].length;
        matched = true;
        break;
      }
      if (!matched) { out += esc(src[i]); i += 1; }   // never stall
    }
    return out + esc(src.slice(i));
  }

  window.Hl = {
    line, langOf, esc,
    has: (lang) => Boolean(LANGS[lang]),
    // Preferences quotes this rather than hardcoding a number that would drift.
    languages: () => Object.keys(LANGS).length,
  };
})();
