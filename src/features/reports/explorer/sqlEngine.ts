// Data explorer: a small, read-only SQL engine that runs in the browser over tables the person may already see.
// It understands read-only SELECT queries in the style of Metabase's native questions: WITH (common table
// expressions), subqueries in FROM, IN, EXISTS and as values, UNION / UNION ALL / INTERSECT / EXCEPT with ORDER BY
// and LIMIT over the whole result, joins, filters, grouping, window functions (ROW_NUMBER, RANK, DENSE_RANK, NTILE,
// LAG, LEAD, FIRST_VALUE, LAST_VALUE, and running SUM/COUNT/AVG/MIN/MAX … OVER (PARTITION BY … ORDER BY …)),
// CASE, LIKE, BETWEEN, IS NULL, text/date functions, and {{parameters}}.

export type SqlValue = string | number | boolean | null
export type SqlRow = Record<string, SqlValue>
export type SqlColumnType = 'text' | 'number' | 'date' | 'bool'
export type SqlTable = { name: string; columns: { name: string; type: SqlColumnType }[]; rows: SqlRow[] }
export type SqlResult = { columns: string[]; rows: SqlValue[][]; truncated: boolean; ms: number }

export const SQL_LIMITS = { resultRows: 5000, workRows: 250_000, ms: 5000, length: 20_000, unionBranches: 25 } as const

export class SqlError extends Error {
  constructor(
    message: string,
    public position = -1,
  ) {
    super(message)
  }
}

// --- Tokens ---

type Token =
  | { kind: 'number'; value: number; at: number }
  | { kind: 'string'; value: string; at: number }
  | { kind: 'name'; value: string; quoted: boolean; at: number }
  | { kind: 'param'; value: string; at: number }
  | { kind: 'op'; value: string; at: number }
  | { kind: 'end'; value?: undefined; at: number }

const KEYWORDS = new Set([
  'select',
  'distinct',
  'from',
  'where',
  'group',
  'by',
  'having',
  'order',
  'asc',
  'desc',
  'limit',
  'offset',
  'join',
  'inner',
  'left',
  'outer',
  'on',
  'as',
  'and',
  'or',
  'not',
  'in',
  'is',
  'null',
  'like',
  'between',
  'case',
  'when',
  'then',
  'else',
  'end',
  'true',
  'false',
  'nulls',
  'first',
  'last',
  'union',
  'all',
  'intersect',
  'except',
  'with',
  'exists',
  'over',
  'partition',
  'recursive',
])

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  const fail = (message: string) => {
    throw new SqlError(message, at)
  }
  while (at < sql.length) {
    const char = sql[at]
    if (/\s/.test(char)) {
      at++
      continue
    }
    if (char === '-' && sql[at + 1] === '-') {
      while (at < sql.length && sql[at] !== '\n') at++
      continue
    }
    if (char === '/' && sql[at + 1] === '*') {
      const close = sql.indexOf('*/', at + 2)
      at = close < 0 ? sql.length : close + 2
      continue
    }
    const start = at
    if (char === '{' && sql[at + 1] === '{') {
      const close = sql.indexOf('}}', at + 2)
      if (close < 0) fail('A parameter is missing its closing }}.')
      const name = sql.slice(at + 2, close).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`“${name}” is not a parameter name. Use letters, digits and _.`)
      tokens.push({ kind: 'param', value: name.toLowerCase(), at: start })
      at = close + 2
      continue
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(sql[at + 1] || ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(at))
      tokens.push({ kind: 'number', value: Number(match![0]), at: start })
      at += match![0].length
      continue
    }
    if (char === "'") {
      let value = ''
      at++
      for (;;) {
        if (at >= sql.length) fail('A text value is missing its closing quote.')
        if (sql[at] === "'") {
          if (sql[at + 1] === "'") {
            value += "'"
            at += 2
            continue
          }
          at++
          break
        }
        value += sql[at++]
      }
      tokens.push({ kind: 'string', value, at: start })
      continue
    }
    if (char === '"' || char === '`') {
      const close = sql.indexOf(char, at + 1)
      if (close < 0) fail('A quoted name is missing its closing quote.')
      tokens.push({ kind: 'name', value: sql.slice(at + 1, close).toLowerCase(), quoted: true, at: start })
      at = close + 1
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(at))!
      tokens.push({ kind: 'name', value: match[0].toLowerCase(), quoted: false, at: start })
      at += match[0].length
      continue
    }
    const two = sql.slice(at, at + 2)
    if (['<=', '>=', '<>', '!=', '||'].includes(two)) {
      tokens.push({ kind: 'op', value: two === '!=' ? '<>' : two, at: start })
      at += 2
      continue
    }
    if ('=<>+-*/%(),.;'.includes(char)) {
      tokens.push({ kind: 'op', value: char, at: start })
      at++
      continue
    }
    fail(`“${char}” is not understood here.`)
  }
  tokens.push({ kind: 'end', at: sql.length })
  return tokens
}

// --- Syntax ---

export type Expr =
  | { type: 'literal'; value: SqlValue }
  | { type: 'column'; table?: string; name: string; at: number }
  | { type: 'param'; name: string }
  | { type: 'unary'; op: '-' | 'not'; arg: Expr }
  | { type: 'binary'; op: string; left: Expr; right: Expr }
  | { type: 'call'; name: string; args: Expr[]; star: boolean; distinct: boolean; at: number }
  | { type: 'case'; operand?: Expr; whens: { when: Expr; then: Expr }[]; otherwise?: Expr }
  | { type: 'in'; arg: Expr; list: Expr[]; not: boolean }
  | { type: 'between'; arg: Expr; low: Expr; high: Expr; not: boolean }
  | { type: 'like'; arg: Expr; pattern: Expr; not: boolean }
  | { type: 'isnull'; arg: Expr; not: boolean }
  | { type: 'subquery'; mode: 'scalar' | 'exists' | 'in'; statement: Statement; arg?: Expr; not: boolean; at: number }
  | { type: 'window'; call: Expr & { type: 'call' }; partition: Expr[]; order: OrderItem[]; at: number }

type OrderItem = { expr: Expr; desc: boolean }
export type SetOp = 'union' | 'union all' | 'intersect' | 'except'
type SetNode =
  | { kind: 'select'; query: Query }
  | { kind: 'set'; op: SetOp; left: SetNode; right: SetNode }
  | { kind: 'nested'; statement: Statement }
/** A whole query: WITH parts, the SELECTs joined by UNION and friends, and ORDER BY / LIMIT over the result. */
export type Statement = {
  ctes: { name: string; columns?: string[]; body: Statement; at: number }[]
  body: SetNode
  orderBy: OrderItem[]
  limit?: number
  offset?: number
}

type SelectItem = { star: true; table?: string } | { star: false; expr: Expr; alias?: string; text: string }
type Source = { table: string; alias: string; at: number; subquery?: Statement }
export type Query = {
  distinct: boolean
  items: SelectItem[]
  from?: Source
  joins: { kind: 'inner' | 'left'; source: Source; on: Expr }[]
  where?: Expr
  groupBy: Expr[]
  having?: Expr
  orderBy: OrderItem[]
  limit?: number
  offset?: number
}

export const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max', 'string_agg', 'group_concat'])
/** Functions that only work with OVER (…). SUM, COUNT, AVG, MIN and MAX work both ways. */
export const WINDOW_FUNCTIONS = new Set([
  'row_number',
  'rank',
  'dense_rank',
  'ntile',
  'lag',
  'lead',
  'first_value',
  'last_value',
])
const WINDOW_AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max'])

const rightmost = (node: SetNode): SetNode => (node.kind === 'set' ? rightmost(node.right) : node)
const branchCount = (node: SetNode): number =>
  node.kind === 'set' ? branchCount(node.left) + branchCount(node.right) : 1
const hasOrderOrLimit = (query: Query) =>
  query.orderBy.length > 0 || query.limit !== undefined || query.offset !== undefined

class Parser {
  index = 0
  constructor(
    public tokens: Token[],
    public sql: string,
  ) {}
  get token() {
    return this.tokens[this.index]
  }
  fail(message: string, token: Token = this.token): never {
    throw new SqlError(message, token.at)
  }
  isWord(word: string, offset = 0) {
    const token = this.tokens[this.index + offset]
    return token?.kind === 'name' && !token.quoted && token.value === word
  }
  isOp(op: string) {
    return this.token.kind === 'op' && this.token.value === op
  }
  word(word: string) {
    if (!this.isWord(word)) this.fail(`Expected ${word.toUpperCase()} here.`)
    this.index++
  }
  op(op: string) {
    if (!this.isOp(op)) this.fail(`Expected “${op}” here.`)
    this.index++
  }
  maybeWord(word: string) {
    if (this.isWord(word)) {
      this.index++
      return true
    }
    return false
  }
  maybeOp(op: string) {
    if (this.isOp(op)) {
      this.index++
      return true
    }
    return false
  }
  name(what: string) {
    const token = this.token
    if (token.kind !== 'name' || (!token.quoted && KEYWORDS.has(token.value))) this.fail(`Expected ${what} here.`)
    this.index++
    return token.value
  }

  parse(): Statement {
    const statement = this.statement()
    this.maybeOp(';')
    if (this.token.kind !== 'end') {
      if (this.isWord('select')) this.fail('Run one SELECT at a time, or join them with UNION ALL.')
      this.fail('This part of the query is not understood.')
    }
    return statement
  }

  statement(): Statement {
    const ctes: Statement['ctes'] = []
    if (this.maybeWord('with')) {
      if (this.isWord('recursive')) this.fail('WITH RECURSIVE is not supported.')
      do {
        const at = this.token.at
        const name = this.name('a name for the WITH query')
        let columns: string[] | undefined
        if (this.maybeOp('(')) {
          columns = []
          do columns.push(this.name('a column name'))
          while (this.maybeOp(','))
          this.op(')')
        }
        this.word('as')
        this.op('(')
        const body = this.statement()
        this.op(')')
        if (ctes.some(cte => cte.name === name)) this.fail(`${name} is defined twice in WITH.`)
        ctes.push({ name, columns, body, at })
      } while (this.maybeOp(','))
    }
    const body = this.setExpr()
    const statement: Statement = { ctes, body, orderBy: [] }
    // ORDER BY and LIMIT after the last SELECT of a UNION sort and cut the whole result, as in every database.
    const last = rightmost(body)
    if (body.kind === 'set' && last.kind === 'select' && hasOrderOrLimit(last.query)) {
      statement.orderBy = last.query.orderBy
      statement.limit = last.query.limit
      statement.offset = last.query.offset
      last.query.orderBy = []
      delete last.query.limit
      delete last.query.offset
    }
    if (this.maybeWord('order')) {
      this.word('by')
      statement.orderBy = this.orderList()
    }
    if (this.maybeWord('limit')) statement.limit = this.count('LIMIT')
    if (this.maybeWord('offset')) statement.offset = this.count('OFFSET')
    return statement
  }
  setExpr(): SetNode {
    let left = this.intersectExpr()
    for (;;) {
      let op: SetOp | null = null
      if (this.maybeWord('union')) op = this.maybeWord('all') ? 'union all' : (this.maybeWord('distinct'), 'union')
      else if (this.maybeWord('except')) {
        this.maybeWord('distinct')
        op = 'except'
      }
      if (!op) return left
      left = this.joinSets(op, left, this.intersectExpr())
    }
  }
  intersectExpr(): SetNode {
    let left = this.setTerm()
    while (this.maybeWord('intersect')) {
      this.maybeWord('distinct')
      left = this.joinSets('intersect', left, this.setTerm())
    }
    return left
  }
  joinSets(op: SetOp, left: SetNode, right: SetNode): SetNode {
    const before = rightmost(left)
    if (before.kind === 'select' && hasOrderOrLimit(before.query))
      this.fail('Put ORDER BY and LIMIT after the last SELECT, or wrap that SELECT in parentheses.')
    const node: SetNode = { kind: 'set', op, left, right }
    if (branchCount(node) > SQL_LIMITS.unionBranches)
      this.fail(`A query can combine at most ${SQL_LIMITS.unionBranches} SELECT statements.`)
    return node
  }
  setTerm(): SetNode {
    if (this.isOp('(') && (this.isWord('select', 1) || this.isWord('with', 1))) {
      this.index++
      const statement = this.statement()
      this.op(')')
      return { kind: 'nested', statement }
    }
    return { kind: 'select', query: this.select() }
  }
  orderList(): OrderItem[] {
    const items: OrderItem[] = []
    do {
      const expr = this.expr()
      let desc = false
      if (this.maybeWord('desc')) desc = true
      else this.maybeWord('asc')
      if (this.maybeWord('nulls')) {
        if (!this.maybeWord('first')) this.word('last')
      }
      items.push({ expr, desc })
    } while (this.maybeOp(','))
    return items
  }
  /** ( SELECT … ) inside an expression. */
  subquery(): Statement {
    if (!this.isWord('select') && !this.isWord('with')) this.fail('Expected a SELECT here.')
    const statement = this.statement()
    this.op(')')
    return statement
  }

  select(): Query {
    this.word('select')
    const distinct = this.maybeWord('distinct')
    const items: SelectItem[] = []
    do {
      const start = this.token.at
      if (this.isOp('*')) {
        this.index++
        items.push({ star: true })
        continue
      }
      if (
        this.token.kind === 'name' &&
        this.tokens[this.index + 1]?.value === '.' &&
        this.tokens[this.index + 2]?.value === '*'
      ) {
        const table = this.token.value
        this.index += 3
        items.push({ star: true, table })
        continue
      }
      const expr = this.expr()
      const text = this.sql.slice(start, this.token.at).trim()
      let alias: string | undefined
      if (this.maybeWord('as')) alias = this.name('a column name')
      else if (this.token.kind === 'name' && (this.token.quoted || !KEYWORDS.has(this.token.value)))
        alias = this.name('a column name')
      items.push({ star: false, expr, alias, text })
    } while (this.maybeOp(','))
    const query: Query = { distinct, items, joins: [], groupBy: [], orderBy: [] }
    if (this.maybeWord('from')) {
      query.from = this.source()
      for (;;) {
        let kind: 'inner' | 'left' | null = null
        if (this.isWord('join')) kind = 'inner'
        else if (this.isWord('inner') && this.isWord('join', 1)) {
          this.index++
          kind = 'inner'
        } else if (this.isWord('left')) {
          this.index++
          this.maybeWord('outer')
          kind = 'left'
        } else if (this.isOp(',')) this.fail('Join tables with JOIN … ON …, not with a comma.')
        if (!kind) break
        this.word('join')
        const source = this.source()
        this.word('on')
        query.joins.push({ kind, source, on: this.expr() })
      }
    }
    if (this.maybeWord('where')) query.where = this.expr()
    if (this.maybeWord('group')) {
      this.word('by')
      do query.groupBy.push(this.expr())
      while (this.maybeOp(','))
    }
    if (this.maybeWord('having')) query.having = this.expr()
    if (this.maybeWord('order')) {
      this.word('by')
      query.orderBy = this.orderList()
    }
    if (this.maybeWord('limit')) query.limit = this.count('LIMIT')
    if (this.maybeWord('offset')) query.offset = this.count('OFFSET')
    return query
  }
  count(what: string) {
    const token = this.token
    if (token.kind !== 'number' || !Number.isInteger(token.value) || token.value < 0)
      this.fail(`${what} needs a whole number.`)
    this.index++
    return token.value
  }
  source(): Source {
    const at = this.token.at
    if (this.maybeOp('(')) {
      const subquery = this.subquery()
      this.maybeWord('as')
      if (this.token.kind !== 'name' || (!this.token.quoted && KEYWORDS.has(this.token.value)))
        this.fail('Give the query inside FROM a name, like ( SELECT … ) AS t.')
      const alias = this.name('a name for the query')
      return { table: alias, alias, at, subquery }
    }
    const table = this.name('a table name')
    let alias = table
    if (this.maybeWord('as')) alias = this.name('a table alias')
    else if (this.token.kind === 'name' && (this.token.quoted || !KEYWORDS.has(this.token.value)))
      alias = this.name('a table alias')
    return { table, alias, at }
  }

  expr(): Expr {
    return this.or()
  }
  or(): Expr {
    let left = this.and()
    while (this.maybeWord('or')) left = { type: 'binary', op: 'or', left, right: this.and() }
    return left
  }
  and(): Expr {
    let left = this.not()
    while (this.maybeWord('and')) left = { type: 'binary', op: 'and', left, right: this.not() }
    return left
  }
  not(): Expr {
    if (this.maybeWord('not')) return { type: 'unary', op: 'not', arg: this.not() }
    return this.comparison()
  }
  comparison(): Expr {
    const left = this.concat()
    if (this.token.kind === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(this.token.value)) {
      const op = this.token.value
      this.index++
      return { type: 'binary', op, left, right: this.concat() }
    }
    if (this.maybeWord('is')) {
      const not = this.maybeWord('not')
      this.word('null')
      return { type: 'isnull', arg: left, not }
    }
    const not = this.isWord('not') && (this.isWord('in', 1) || this.isWord('like', 1) || this.isWord('between', 1))
    if (not) this.index++
    if (this.maybeWord('in')) {
      this.op('(')
      if (this.isWord('select') || this.isWord('with'))
        return {
          type: 'subquery',
          mode: 'in',
          arg: left,
          statement: this.subquery(),
          not,
          at: left.type === 'column' ? left.at : -1,
        }
      const list: Expr[] = []
      do list.push(this.concat())
      while (this.maybeOp(','))
      this.op(')')
      return { type: 'in', arg: left, list, not }
    }
    if (this.maybeWord('like')) return { type: 'like', arg: left, pattern: this.concat(), not }
    if (this.maybeWord('between')) {
      const low = this.concat()
      this.word('and')
      return { type: 'between', arg: left, low, high: this.concat(), not }
    }
    return left
  }
  concat(): Expr {
    let left = this.additive()
    while (this.maybeOp('||')) left = { type: 'binary', op: '||', left, right: this.additive() }
    return left
  }
  additive(): Expr {
    let left = this.multiplicative()
    while (this.isOp('+') || this.isOp('-')) {
      const op = String(this.token.value)
      this.index++
      left = { type: 'binary', op, left, right: this.multiplicative() }
    }
    return left
  }
  multiplicative(): Expr {
    let left = this.unary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = String(this.token.value)
      this.index++
      left = { type: 'binary', op, left, right: this.unary() }
    }
    return left
  }
  unary(): Expr {
    if (this.maybeOp('-')) return { type: 'unary', op: '-', arg: this.unary() }
    if (this.maybeOp('+')) return this.unary()
    return this.primary()
  }
  primary(): Expr {
    const token = this.token
    if (token.kind === 'number' || token.kind === 'string') {
      this.index++
      return { type: 'literal', value: token.value }
    }
    if (token.kind === 'param') {
      this.index++
      return { type: 'param', name: token.value }
    }
    if (this.maybeOp('(')) {
      if (this.isWord('select') || this.isWord('with'))
        return { type: 'subquery', mode: 'scalar', statement: this.subquery(), not: false, at: token.at }
      const inner = this.expr()
      this.op(')')
      return inner
    }
    if (token.kind !== 'name') this.fail('Expected a value, a column or a function here.')
    if (!token.quoted) {
      if (token.value === 'null') return this.skip({ type: 'literal', value: null })
      if (token.value === 'true') return this.skip({ type: 'literal', value: true })
      if (token.value === 'false') return this.skip({ type: 'literal', value: false })
      if (token.value === 'current_date')
        return this.skip({ type: 'call', name: 'today', args: [], star: false, distinct: false, at: token.at })
      if (token.value === 'case') return this.caseExpr()
      if (token.value === 'exists' && this.tokens[this.index + 1]?.value === '(') {
        this.index += 2
        return { type: 'subquery', mode: 'exists', statement: this.subquery(), not: false, at: token.at }
      }
      if (KEYWORDS.has(token.value)) this.fail(`${token.value.toUpperCase()} is not expected here.`)
    }
    this.index++
    if (!token.quoted && this.isOp('(')) {
      this.index++
      const call: Expr & { type: 'call' } = {
        type: 'call',
        name: token.value,
        args: [],
        star: false,
        distinct: false,
        at: token.at,
      }
      if (this.maybeOp('*')) call.star = true
      else if (!this.isOp(')')) {
        call.distinct = this.maybeWord('distinct')
        do call.args.push(this.expr())
        while (this.maybeOp(','))
      }
      this.op(')')
      if (this.maybeWord('over')) {
        this.op('(')
        const partition: Expr[] = []
        if (this.maybeWord('partition')) {
          this.word('by')
          do partition.push(this.expr())
          while (this.maybeOp(','))
        }
        let order: OrderItem[] = []
        if (this.maybeWord('order')) {
          this.word('by')
          order = this.orderList()
        }
        this.op(')')
        return { type: 'window', call, partition, order, at: token.at }
      }
      return call
    }
    if (this.maybeOp('.')) {
      const name = this.name('a column name')
      return { type: 'column', table: token.value, name, at: token.at }
    }
    return { type: 'column', name: token.value, at: token.at }
  }
  skip(expr: Expr) {
    this.index++
    return expr
  }
  caseExpr(): Expr {
    this.word('case')
    const node: Expr & { type: 'case' } = { type: 'case', whens: [] }
    if (!this.isWord('when')) node.operand = this.expr()
    while (this.maybeWord('when')) {
      const when = this.expr()
      this.word('then')
      node.whens.push({ when, then: this.expr() })
    }
    if (!node.whens.length) this.fail('CASE needs at least one WHEN … THEN ….')
    if (this.maybeWord('else')) node.otherwise = this.expr()
    this.word('end')
    return node
  }
}

export function parseQuery(sql: string): Statement {
  if (sql.length > SQL_LIMITS.length) throw new SqlError(`A query can be at most ${SQL_LIMITS.length} characters.`)
  const tokens = tokenize(sql)
  if (tokens[0].kind === 'end') throw new SqlError('Write a SELECT query to run.')
  const first = tokens[0]
  if (
    first.kind === 'name' &&
    ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant'].includes(first.value)
  )
    throw new SqlError('Only SELECT queries can be run here: the explorer is read-only.', first.at)
  return new Parser(tokens, sql).parse()
}

/** The direct parts of an expression, and the queries inside it. */
function exprParts(expr: Expr): { exprs: Expr[]; statements: Statement[] } {
  switch (expr.type) {
    case 'unary':
      return { exprs: [expr.arg], statements: [] }
    case 'binary':
      return { exprs: [expr.left, expr.right], statements: [] }
    case 'call':
      return { exprs: expr.args, statements: [] }
    case 'case':
      return {
        exprs: [
          ...(expr.operand ? [expr.operand] : []),
          ...expr.whens.flatMap(item => [item.when, item.then]),
          ...(expr.otherwise ? [expr.otherwise] : []),
        ],
        statements: [],
      }
    case 'in':
      return { exprs: [expr.arg, ...expr.list], statements: [] }
    case 'between':
      return { exprs: [expr.arg, expr.low, expr.high], statements: [] }
    case 'like':
      return { exprs: [expr.arg, expr.pattern], statements: [] }
    case 'isnull':
      return { exprs: [expr.arg], statements: [] }
    case 'subquery':
      return { exprs: expr.arg ? [expr.arg] : [], statements: [expr.statement] }
    case 'window':
      return { exprs: [expr.call, ...expr.partition, ...expr.order.map(item => item.expr)], statements: [] }
    default:
      return { exprs: [], statements: [] }
  }
}
const someExpr = (expr: Expr, test: (node: Expr) => boolean): boolean =>
  test(expr) || exprParts(expr).exprs.some(part => someExpr(part, test))

/** The tables a query reads, so they can be loaded before it runs. Names from WITH are not tables. */
export function referencedTables(sql: string): string[] {
  try {
    const names: string[] = []
    const visitExpr = (expr: Expr, local: Set<string>) => {
      const parts = exprParts(expr)
      parts.exprs.forEach(part => visitExpr(part, local))
      parts.statements.forEach(statement => visitStatement(statement, local))
    }
    const visitQuery = (query: Query, local: Set<string>) => {
      for (const source of [query.from, ...query.joins.map(join => join.source)]) {
        if (!source) continue
        if (source.subquery) visitStatement(source.subquery, local)
        else if (!local.has(source.table) && !names.includes(source.table)) names.push(source.table)
      }
      const exprs = [
        ...query.items.flatMap(item => (item.star ? [] : [item.expr])),
        ...query.joins.map(join => join.on),
        ...(query.where ? [query.where] : []),
        ...query.groupBy,
        ...(query.having ? [query.having] : []),
        ...query.orderBy.map(item => item.expr),
      ]
      exprs.forEach(expr => visitExpr(expr, local))
    }
    const visitNode = (node: SetNode, local: Set<string>) => {
      if (node.kind === 'select') visitQuery(node.query, local)
      else if (node.kind === 'nested') visitStatement(node.statement, local)
      else {
        visitNode(node.left, local)
        visitNode(node.right, local)
      }
    }
    const visitStatement = (statement: Statement, outer: Set<string>) => {
      const local = new Set(outer)
      for (const cte of statement.ctes) {
        visitStatement(cte.body, local)
        local.add(cte.name)
      }
      visitNode(statement.body, local)
      statement.orderBy.forEach(item => visitExpr(item.expr, local))
    }
    visitStatement(parseQuery(sql), new Set())
    return names
  } catch {
    return []
  }
}

/** The {{parameters}} a query asks for, in order. */
export function queryParams(sql: string): string[] {
  const names: string[] = []
  for (const match of sql.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    const name = match[1].toLowerCase()
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** The parameter names used as table identifiers in FROM and JOIN clauses. */
export function tableIdentifierParams(sql: string): string[] {
  const names: string[] = []
  for (const match of sql.matchAll(/\b(?:from|join)\s+\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gi)) {
    const name = match[1].toLowerCase()
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Resolves {{table_name}} only when it appears as a FROM/JOIN identifier.
 * Identifiers are selected from the caller's allow-list, never interpolated unchecked.
 */
export function resolveTableIdentifierParams(
  sql: string,
  params: Record<string, string>,
  allowedTables: string[],
): string {
  const allowed = new Map(allowedTables.map(name => [name.toLowerCase(), name]))
  return sql.replace(
    /\b(from|join)\s+\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gi,
    (_match, clause: string, rawName: string) => {
      const parameter = rawName.toLowerCase()
      const selected = (params[parameter] ?? '').trim()
      if (!selected) throw new SqlError(`Choose a table for {{${parameter}}} before running.`)
      const table = allowed.get(selected.toLowerCase())
      if (!table) throw new SqlError(`“${selected}” is not an available table for {{${parameter}}}.`)
      return `${clause} ${table}`
    },
  )
}

// --- Values ---

const DAY = 86_400_000
const ISO = /^(\d{4})-(\d{2})-(\d{2})/
const dayOf = (value: SqlValue): number | null => {
  if (typeof value !== 'string') return null
  const match = ISO.exec(value)
  if (!match) return null
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(time) ? Math.round(time / DAY) : null
}
const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10)
const numeric = (value: SqlValue): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}
const textOf = (value: SqlValue) =>
  value === null ? '' : typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
const truthy = (value: SqlValue) => value === true || (typeof value === 'number' && value !== 0) || value === 'true'

/** Compares two values: numbers as numbers, text ignoring case, dates as dates. Null is never equal to anything. */
export function compare(a: SqlValue, b: SqlValue): number | null {
  if (a === null || b === null) return null
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const x = typeof a === 'boolean' ? a : truthy(a)
    const y = typeof b === 'boolean' ? b : truthy(b)
    return x === y ? 0 : x ? 1 : -1
  }
  if (typeof a === 'number' || typeof b === 'number') {
    const x = numeric(a),
      y = numeric(b)
    if (x !== null && y !== null) return x === y ? 0 : x < y ? -1 : 1
  }
  const x = String(a).toLowerCase(),
    y = String(b).toLowerCase()
  return x === y ? 0 : x < y ? -1 : 1
}
/** Sort order: nulls last, then as compare(), with text compared naturally. */
const sortCompare = (a: SqlValue, b: SqlValue) => {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'string' && typeof b === 'string')
    return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  return compare(a, b) ?? 0
}

function likeToRegex(pattern: string) {
  let out = '^'
  for (const char of pattern)
    out += char === '%' ? '.*' : char === '_' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${out}$`, 'is')
}

// --- Running ---

type Bound = Record<string, SqlRow | null>
type Context = { row: Bound; group?: Bound[]; index?: number }
type Scope = { aliases: string[]; columns: Map<string, Set<string>> }

const SCALAR = new Set([
  'lower',
  'upper',
  'length',
  'trim',
  'substr',
  'substring',
  'replace',
  'concat',
  'coalesce',
  'ifnull',
  'nullif',
  'round',
  'abs',
  'floor',
  'ceil',
  'ceiling',
  'today',
  'now',
  'date',
  'year',
  'month',
  'day',
  'week_start',
  'month_start',
  'quarter',
  'days_between',
  'date_add',
])
export const SQL_FUNCTIONS = [...AGGREGATES, ...SCALAR, ...WINDOW_FUNCTIONS].filter(
  name => !['group_concat', 'substring', 'ceiling', 'now'].includes(name),
)

export function runQuery(
  sql: string,
  tables: Record<string, SqlTable | undefined>,
  options: { params?: Record<string, string>; today?: string; now?: () => number } = {},
): SqlResult {
  const now = options.now || (() => Date.now())
  const started = now()
  const query = parseQuery(sql)
  const params = Object.fromEntries(
    Object.entries(options.params || {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
  const today = options.today || new Date().toISOString().slice(0, 10)
  const budget = { work: 0, started, now }
  const tick = (count = 1) => {
    budget.work += count
    if (budget.work > SQL_LIMITS.workRows * 4)
      throw new SqlError('This query does too much work. Add a filter or a LIMIT.')
    if (budget.work % 2000 < count && now() - started > SQL_LIMITS.ms)
      throw new SqlError(
        `This query took longer than ${SQL_LIMITS.ms / 1000} seconds and was stopped. Add a filter or a LIMIT.`,
      )
  }
  const env: Env = { params, today, budget, tick }
  const result = runStatement(query, tables, env)
  return {
    columns: result.columns,
    rows: result.rows.slice(0, SQL_LIMITS.resultRows),
    truncated: result.truncated || result.rows.length > SQL_LIMITS.resultRows,
    ms: Math.max(0, Math.round(now() - started)),
  }
}

type Env = {
  params: Record<string, string>
  today: string
  budget: QueryBudget
  tick: (count?: number) => void
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/
/** A result made into a table, so later parts of the query can read it like any other. */
function toTable(name: string, result: SqlResult, names?: string[]): SqlTable {
  if (names && names.length !== result.columns.length)
    throw new SqlError(`${name} names ${names.length} columns but its query returns ${result.columns.length}.`)
  const columns = (names || result.columns).map((column, index) => {
    const sample = result.rows.find(row => row[index] !== null)?.[index]
    const type: SqlColumnType =
      typeof sample === 'number'
        ? 'number'
        : typeof sample === 'boolean'
          ? 'bool'
          : typeof sample === 'string' && ISO_DATE.test(sample)
            ? 'date'
            : 'text'
    return { name: column, type }
  })
  return {
    name,
    columns,
    rows: result.rows.map(row => Object.fromEntries(columns.map((column, index) => [column.name, row[index] ?? null]))),
  }
}

/** Runs WITH parts, then the SELECTs and how they combine, then ORDER BY / LIMIT over the whole result. */
function runStatement(statement: Statement, base: Record<string, SqlTable | undefined>, env: Env): SqlResult {
  const tables = { ...base }
  for (const cte of statement.ctes)
    tables[cte.name] = toTable(cte.name, runStatement(cte.body, tables, env), cte.columns)
  let result = runNode(statement.body, tables, env)
  if (statement.orderBy.length || statement.limit !== undefined || statement.offset !== undefined) {
    const name = '__result'
    result = runSelect(
      {
        distinct: false,
        items: [{ star: true }],
        from: { table: name, alias: name, at: -1 },
        joins: [],
        groupBy: [],
        orderBy: statement.orderBy,
        limit: statement.limit,
        offset: statement.offset,
      },
      { ...tables, [name]: toTable(name, result) },
      env,
    )
  }
  return result
}

function runNode(node: SetNode, tables: Record<string, SqlTable | undefined>, env: Env): SqlResult {
  if (node.kind === 'select') return runSelect(node.query, tables, env)
  if (node.kind === 'nested') return runStatement(node.statement, tables, env)
  const left = runNode(node.left, tables, env)
  const right = runNode(node.right, tables, env)
  if (left.columns.length !== right.columns.length)
    throw new SqlError(
      `Every SELECT in a ${node.op.toUpperCase()} must return the same number of columns (${left.columns.length} and ${right.columns.length}).`,
    )
  env.tick(left.rows.length + right.rows.length)
  const key = (row: SqlValue[]) => JSON.stringify(row)
  const distinct = (rows: SqlValue[][]) => {
    const seen = new Set<string>()
    return rows.filter(row => {
      const id = key(row)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }
  let rows: SqlValue[][]
  if (node.op === 'union all') rows = [...left.rows, ...right.rows]
  else if (node.op === 'union') rows = distinct([...left.rows, ...right.rows])
  else {
    const other = new Set(right.rows.map(key))
    rows = distinct(left.rows).filter(row => other.has(key(row)) === (node.op === 'intersect'))
  }
  if (rows.length > SQL_LIMITS.workRows) throw new SqlError('This query does too much work. Add a filter or a LIMIT.')
  return { columns: left.columns, rows, truncated: left.truncated || right.truncated, ms: 0 }
}

type QueryBudget = { work: number; started: number; now: () => number }

function runSelect(query: Query, tables: Record<string, SqlTable | undefined>, env: Env): SqlResult {
  const { params, today, budget, tick } = env
  const { now, started } = budget
  // Tables and the columns each alias offers.
  const sources = query.from ? [query.from, ...query.joins.map(join => join.source)] : []
  const scope: Scope = { aliases: [], columns: new Map() }
  const data = new Map<string, SqlTable>()
  for (const source of sources) {
    const table = source.subquery
      ? toTable(source.alias, runStatement(source.subquery, tables, env))
      : tables[source.table]
    if (!table) throw new SqlError(`There is no table called ${source.table}.`, source.at)
    if (scope.columns.has(source.alias))
      throw new SqlError(`${source.alias} is used twice. Give one of them another alias.`, source.at)
    scope.aliases.push(source.alias)
    scope.columns.set(source.alias, new Set(table.columns.map(column => column.name)))
    data.set(source.alias, table)
  }
  const resolve = (expr: Expr & { type: 'column' }): string => {
    if (expr.table) {
      if (!scope.columns.has(expr.table))
        throw new SqlError(`There is no table or alias called ${expr.table} in this query.`, expr.at)
      if (!scope.columns.get(expr.table)!.has(expr.name))
        throw new SqlError(`${expr.table} has no column called ${expr.name}.`, expr.at)
      return expr.table
    }
    const owners = scope.aliases.filter(alias => scope.columns.get(alias)!.has(expr.name))
    if (!owners.length) throw new SqlError(`There is no column called ${expr.name}.`, expr.at)
    if (owners.length > 1)
      throw new SqlError(`${expr.name} is in more than one table. Write it as table.${expr.name}.`, expr.at)
    return owners[0]
  }
  // Output aliases may be used in ORDER BY (and, as most databases allow, in GROUP BY and HAVING).
  const outputAliases = new Map<string, Expr>()
  for (const item of query.items) if (!item.star && item.alias) outputAliases.set(item.alias, item.expr)

  const isAggregate = (expr: Expr): boolean => {
    switch (expr.type) {
      case 'call':
        return AGGREGATES.has(expr.name) || expr.args.some(isAggregate)
      case 'unary':
        return isAggregate(expr.arg)
      case 'binary':
        return isAggregate(expr.left) || isAggregate(expr.right)
      case 'case':
        return Boolean(
          (expr.operand && isAggregate(expr.operand)) ||
            expr.whens.some(item => isAggregate(item.when) || isAggregate(item.then)) ||
            (expr.otherwise && isAggregate(expr.otherwise)),
        )
      case 'in':
        return isAggregate(expr.arg) || expr.list.some(isAggregate)
      case 'between':
        return isAggregate(expr.arg) || isAggregate(expr.low) || isAggregate(expr.high)
      case 'like':
        return isAggregate(expr.arg) || isAggregate(expr.pattern)
      case 'isnull':
        return isAggregate(expr.arg)
      case 'subquery':
        return Boolean(expr.arg && isAggregate(expr.arg))
      default:
        return false
    }
  }
  const isWindow = (expr: Expr) => someExpr(expr, node => node.type === 'window')
  const check = (expr: Expr, aliasesAllowed: boolean) => {
    // Resolves every column now, so a typo is reported before any row is read.
    const walk = (node: Expr) => {
      switch (node.type) {
        case 'column':
          if (
            aliasesAllowed &&
            !node.table &&
            outputAliases.has(node.name) &&
            !scope.aliases.some(alias => scope.columns.get(alias)!.has(node.name))
          )
            return
          resolve(node)
          return
        case 'call':
          if (WINDOW_FUNCTIONS.has(node.name))
            throw new SqlError(
              `${node.name.toUpperCase()}() needs OVER (…), like ${node.name.toUpperCase()}() OVER (ORDER BY …).`,
              node.at,
            )
          if (!AGGREGATES.has(node.name) && !SCALAR.has(node.name))
            throw new SqlError(`${node.name.toUpperCase()}() is not a function here.`, node.at)
          if (node.star && node.name !== 'count') throw new SqlError(`Only COUNT(*) takes *.`, node.at)
          node.args.forEach(walk)
          return
        case 'unary':
          walk(node.arg)
          return
        case 'binary':
          walk(node.left)
          walk(node.right)
          return
        case 'case':
          if (node.operand) walk(node.operand)
          for (const item of node.whens) {
            walk(item.when)
            walk(item.then)
          }
          if (node.otherwise) walk(node.otherwise)
          return
        case 'in':
          walk(node.arg)
          node.list.forEach(walk)
          return
        case 'between':
          walk(node.arg)
          walk(node.low)
          walk(node.high)
          return
        case 'like':
          walk(node.arg)
          walk(node.pattern)
          return
        case 'isnull':
          walk(node.arg)
          return
        case 'param':
          if (!(node.name in params)) throw new SqlError(`Fill in {{${node.name}}} before running.`)
          return
        case 'subquery':
          // The inner query is checked when it runs; it cannot use this query's columns.
          if (node.arg) walk(node.arg)
          return
        case 'window': {
          const name = node.call.name
          if (!WINDOW_FUNCTIONS.has(name) && !WINDOW_AGGREGATES.has(name))
            throw new SqlError(`${name.toUpperCase()}() cannot be used with OVER (…).`, node.at)
          if (node.call.star && name !== 'count') throw new SqlError(`Only COUNT(*) takes *.`, node.at)
          if (['lag', 'lead', 'first_value', 'last_value', 'ntile'].includes(name) && !node.call.args.length)
            throw new SqlError(`${name.toUpperCase()}() needs a value, like ${name.toUpperCase()}(column).`, node.at)
          node.call.args.forEach(walk)
          node.partition.forEach(walk)
          node.order.forEach(item => walk(item.expr))
          return
        }
        default:
          return
      }
    }
    walk(expr)
  }
  for (const where of [query.where, query.having, ...query.groupBy, ...query.joins.map(join => join.on)])
    if (where && isWindow(where))
      throw new SqlError(
        'Window functions like ROW_NUMBER() OVER (…) go in SELECT or ORDER BY. Filter on them from an outer query or WITH.',
      )
  for (const item of query.items) if (!item.star) check(item.expr, false)
  for (const join of query.joins) check(join.on, false)
  if (query.where) {
    check(query.where, false)
    if (isAggregate(query.where)) throw new SqlError('Totals like COUNT() go in HAVING, not WHERE.')
  }
  for (const expr of query.groupBy) check(expr, true)
  if (query.having) check(query.having, true)
  for (const item of query.orderBy) check(item.expr, true)

  const evaluate = (expr: Expr, context: Context): SqlValue => {
    switch (expr.type) {
      case 'literal':
        return expr.value
      case 'param': {
        const value = params[expr.name] ?? ''
        return value === '' ? null : value
      }
      case 'column': {
        if (
          !expr.table &&
          outputAliases.has(expr.name) &&
          !scope.aliases.some(alias => scope.columns.get(alias)!.has(expr.name))
        )
          return evaluate(outputAliases.get(expr.name)!, context)
        const alias = resolve(expr)
        const row = context.row[alias]
        return row ? (row[expr.name] ?? null) : null
      }
      case 'unary': {
        const value = evaluate(expr.arg, context)
        if (expr.op === 'not') return value === null ? null : !truthy(value)
        const number = numeric(value)
        return number === null ? null : -number
      }
      case 'binary': {
        if (expr.op === 'and') {
          const left = evaluate(expr.left, context)
          if (left !== null && !truthy(left)) return false
          const right = evaluate(expr.right, context)
          if (right !== null && !truthy(right)) return false
          return left === null || right === null ? null : true
        }
        if (expr.op === 'or') {
          const left = evaluate(expr.left, context)
          if (left !== null && truthy(left)) return true
          const right = evaluate(expr.right, context)
          if (right !== null && truthy(right)) return true
          return left === null || right === null ? null : false
        }
        const left = evaluate(expr.left, context),
          right = evaluate(expr.right, context)
        if (expr.op === '||') return left === null || right === null ? null : textOf(left) + textOf(right)
        if (['=', '<>', '<', '>', '<=', '>='].includes(expr.op)) {
          const order = compare(left, right)
          if (order === null) return null
          switch (expr.op) {
            case '=':
              return order === 0
            case '<>':
              return order !== 0
            case '<':
              return order < 0
            case '>':
              return order > 0
            case '<=':
              return order <= 0
            default:
              return order >= 0
          }
        }
        // A date plus or minus days is a date; a date minus a date is days.
        const leftDay = dayOf(left),
          rightDay = dayOf(right)
        if (expr.op === '-' && leftDay !== null && rightDay !== null) return leftDay - rightDay
        const x = numeric(left),
          y = numeric(right)
        if (leftDay !== null && y !== null && (expr.op === '+' || expr.op === '-'))
          return isoOf(leftDay + (expr.op === '+' ? y : -y))
        if (x === null || y === null) return null
        switch (expr.op) {
          case '+':
            return x + y
          case '-':
            return x - y
          case '*':
            return x * y
          case '/':
            return y === 0 ? null : x / y
          default:
            return y === 0 ? null : x % y
        }
      }
      case 'case': {
        const operand = expr.operand ? evaluate(expr.operand, context) : undefined
        for (const item of expr.whens) {
          const when = evaluate(item.when, context)
          if (expr.operand ? compare(operand as SqlValue, when) === 0 : when !== null && truthy(when))
            return evaluate(item.then, context)
        }
        return expr.otherwise ? evaluate(expr.otherwise, context) : null
      }
      case 'in': {
        const value = evaluate(expr.arg, context)
        if (value === null) return null
        const hit = expr.list.some(item => compare(value, evaluate(item, context)) === 0)
        return expr.not ? !hit : hit
      }
      case 'between': {
        const value = evaluate(expr.arg, context)
        const low = compare(value, evaluate(expr.low, context)),
          high = compare(value, evaluate(expr.high, context))
        if (low === null || high === null) return null
        const inside = low >= 0 && high <= 0
        return expr.not ? !inside : inside
      }
      case 'like': {
        const value = evaluate(expr.arg, context),
          pattern = evaluate(expr.pattern, context)
        if (value === null || pattern === null) return null
        const hit = likeToRegex(textOf(pattern)).test(textOf(value))
        return expr.not ? !hit : hit
      }
      case 'isnull': {
        const value = evaluate(expr.arg, context)
        const empty = value === null || value === ''
        return expr.not ? !empty : empty
      }
      case 'call':
        return call(expr, context)
      case 'subquery': {
        const result = subqueryResult(expr)
        if (expr.mode === 'exists') return expr.not ? !result.rows.length : result.rows.length > 0
        if (result.columns.length !== 1)
          throw new SqlError('A query used as a value or in IN (…) must return exactly one column.', expr.at)
        if (expr.mode === 'scalar') {
          if (result.rows.length > 1)
            throw new SqlError('A query used as a value returned more than one row. Add a filter or LIMIT 1.', expr.at)
          return result.rows[0]?.[0] ?? null
        }
        const value = evaluate(expr.arg!, context)
        if (value === null) return null
        const hit = result.rows.some(row => compare(value, row[0]) === 0)
        return expr.not ? !hit : hit
      }
      case 'window':
        return windowValues.get(expr)?.[context.index ?? -1] ?? null
    }
  }
  // Queries inside expressions run once; they cannot refer to this query's rows (no correlated subqueries).
  const subqueryResults = new Map<Expr, SqlResult>()
  const subqueryResult = (expr: Expr & { type: 'subquery' }) => {
    let result = subqueryResults.get(expr)
    if (!result) {
      try {
        result = runStatement(expr.statement, tables, env)
      } catch (error) {
        if (error instanceof SqlError && /There is no (column|table or alias) called/.test(error.message))
          throw new SqlError(
            `${error.message} A query inside another one cannot use the outer query's columns; use a JOIN or WITH instead.`,
            error.position,
          )
        throw error
      }
      subqueryResults.set(expr, result)
    }
    return result
  }
  const windowValues = new Map<Expr, SqlValue[]>()
  const call = (expr: Expr & { type: 'call' }, context: Context): SqlValue => {
    if (AGGREGATES.has(expr.name)) {
      const rows = context.group
      if (!rows)
        throw new SqlError(`${expr.name.toUpperCase()}() needs GROUP BY, or to be the only kind of column.`, expr.at)
      if (expr.name === 'count' && expr.star) return rows.length
      let values = rows
        .map(row => evaluate(expr.args[0] ?? { type: 'literal', value: null }, { row }))
        .filter(value => value !== null && value !== '')
      if (expr.distinct) {
        const seen = new Set<string>()
        values = values.filter(value => {
          const key = typeof value === 'string' ? value.toLowerCase() : String(value)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      switch (expr.name) {
        case 'count':
          return values.length
        case 'sum': {
          const numbers = values.map(numeric).filter((value): value is number => value !== null)
          return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null
        }
        case 'avg': {
          const numbers = values.map(numeric).filter((value): value is number => value !== null)
          return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null
        }
        case 'min':
        case 'max': {
          if (!values.length) return null
          return values.reduce((best, value) => {
            const order = sortCompare(value, best)
            return expr.name === 'min' ? (order < 0 ? value : best) : order > 0 ? value : best
          })
        }
        default: {
          const separator = expr.args[1] ? textOf(evaluate(expr.args[1], { row: rows[0] || {} })) : ', '
          return values.map(textOf).join(separator)
        }
      }
    }
    const args = expr.args.map(arg => evaluate(arg, context))
    const [a, b, c] = args
    const need = (count: number) => {
      if (args.length < count)
        throw new SqlError(`${expr.name.toUpperCase()}() needs ${count} value${count === 1 ? '' : 's'}.`, expr.at)
    }
    switch (expr.name) {
      case 'lower':
        need(1)
        return a === null ? null : textOf(a).toLowerCase()
      case 'upper':
        need(1)
        return a === null ? null : textOf(a).toUpperCase()
      case 'length':
        need(1)
        return a === null ? null : textOf(a).length
      case 'trim':
        need(1)
        return a === null ? null : textOf(a).trim()
      case 'substr':
      case 'substring': {
        need(2)
        if (a === null) return null
        const start = Math.max(1, numeric(b) ?? 1)
        const length = c === undefined ? undefined : Math.max(0, numeric(c) ?? 0)
        return textOf(a).substr(start - 1, length)
      }
      case 'replace':
        need(3)
        return a === null ? null : textOf(a).split(textOf(b)).join(textOf(c))
      case 'concat':
        return args.map(textOf).join('')
      case 'coalesce':
      case 'ifnull':
        return args.find(value => value !== null && value !== '') ?? null
      case 'nullif':
        need(2)
        return compare(a, b) === 0 ? null : a
      case 'round': {
        need(1)
        const number = numeric(a)
        if (number === null) return null
        const places = Math.max(0, Math.min(10, numeric(b ?? 0) ?? 0))
        return Math.round(number * 10 ** places) / 10 ** places
      }
      case 'abs':
      case 'floor':
      case 'ceil':
      case 'ceiling': {
        need(1)
        const number = numeric(a)
        if (number === null) return null
        return expr.name === 'abs' ? Math.abs(number) : expr.name === 'floor' ? Math.floor(number) : Math.ceil(number)
      }
      case 'today':
      case 'now':
        return today
      case 'date': {
        need(1)
        const day = dayOf(a)
        return day === null ? null : isoOf(day)
      }
      case 'year':
      case 'month':
      case 'day':
      case 'quarter': {
        need(1)
        const day = dayOf(a)
        if (day === null) return null
        const date = new Date(day * DAY)
        if (expr.name === 'year') return date.getUTCFullYear()
        if (expr.name === 'month') return date.getUTCMonth() + 1
        if (expr.name === 'quarter') return Math.floor(date.getUTCMonth() / 3) + 1
        return date.getUTCDate()
      }
      case 'week_start': {
        need(1)
        const day = dayOf(a)
        if (day === null) return null
        const weekday = new Date(day * DAY).getUTCDay()
        return isoOf(day - ((weekday + 6) % 7))
      }
      case 'month_start': {
        need(1)
        const day = dayOf(a)
        return day === null ? null : `${isoOf(day).slice(0, 7)}-01`
      }
      case 'days_between': {
        need(2)
        const from = dayOf(a),
          to = dayOf(b)
        return from === null || to === null ? null : to - from
      }
      case 'date_add': {
        need(2)
        const day = dayOf(a),
          days = numeric(b)
        return day === null || days === null ? null : isoOf(day + Math.round(days))
      }
      default:
        throw new SqlError(`${expr.name.toUpperCase()}() is not a function here.`, expr.at)
    }
  }

  // FROM and JOIN: equal-column joins are matched through an index; other joins compare every pair.
  let rows: Bound[] = [{}]
  if (query.from) {
    const first = data.get(query.from.alias)!
    rows = first.rows.map(row => ({ [query.from!.alias]: row }))
    tick(rows.length)
    for (const join of query.joins) {
      const alias = join.source.alias
      const right = data.get(alias)!.rows
      const next: Bound[] = []
      let index: Map<string, SqlRow[]> | null = null
      let leftKey: Expr | null = null
      if (
        join.on.type === 'binary' &&
        join.on.op === '=' &&
        join.on.left.type === 'column' &&
        join.on.right.type === 'column'
      ) {
        const leftAlias = resolve(join.on.left),
          rightAlias = resolve(join.on.right)
        const [mine, theirs] =
          rightAlias === alias && leftAlias !== alias
            ? [join.on.right, join.on.left]
            : leftAlias === alias && rightAlias !== alias
              ? [join.on.left, join.on.right]
              : [null, null]
        if (mine && theirs) {
          index = new Map()
          for (const row of right) {
            const value = row[mine.name]
            if (value === null || value === undefined || value === '') continue
            const key = String(value).toLowerCase()
            const list = index.get(key)
            if (list) list.push(row)
            else index.set(key, [row])
          }
          leftKey = theirs
        }
      }
      for (const bound of rows) {
        let matched = false
        const candidates =
          index && leftKey ? index.get(textOf(evaluate(leftKey, { row: bound })).toLowerCase()) || [] : right
        tick(candidates.length || 1)
        for (const row of candidates) {
          const joined = { ...bound, [alias]: row }
          if (index || truthy(evaluate(join.on, { row: joined }) ?? false)) {
            next.push(joined)
            matched = true
            if (next.length > SQL_LIMITS.workRows)
              throw new SqlError(
                'This join makes too many rows. Join on a column that matches one row, or add a filter.',
              )
          }
        }
        if (!matched && join.kind === 'left') next.push({ ...bound, [alias]: null })
      }
      rows = next
    }
  }
  if (query.where) {
    const where = query.where
    rows = rows.filter(row => {
      tick()
      const value = evaluate(where, { row })
      return value !== null && truthy(value)
    })
  }

  // Columns of the result.
  type Out = { name: string; expr: Expr }
  const outs: Out[] = []
  for (const item of query.items) {
    if (item.star) {
      const aliases = item.table ? [item.table] : scope.aliases
      if (item.table && !scope.columns.has(item.table))
        throw new SqlError(`There is no table or alias called ${item.table} in this query.`)
      if (!aliases.length) throw new SqlError('SELECT * needs a FROM table.')
      for (const alias of aliases)
        for (const column of data.get(alias)!.columns) {
          const shared = scope.aliases.filter(other => scope.columns.get(other)!.has(column.name)).length > 1
          outs.push({
            name: shared ? `${alias}.${column.name}` : column.name,
            expr: { type: 'column', table: alias, name: column.name, at: -1 },
          })
        }
    } else
      outs.push({
        name: item.alias || (item.expr.type === 'column' ? item.expr.name : item.text.slice(0, 60) || 'value'),
        expr: item.expr,
      })
  }
  const names = new Map<string, number>()
  for (const out of outs) {
    const seen = names.get(out.name) || 0
    names.set(out.name, seen + 1)
    if (seen) out.name = `${out.name} (${seen + 1})`
  }

  const grouped =
    query.groupBy.length > 0 ||
    outs.some(out => isAggregate(out.expr)) ||
    Boolean(query.having && isAggregate(query.having))
  type Line = { values: SqlValue[]; keys: SqlValue[] }
  let lines: Line[] = []
  const contexts: Context[] = []
  const orderValue = (expr: Expr, context: Context, values: SqlValue[]): SqlValue => {
    if (expr.type === 'literal' && typeof expr.value === 'number' && Number.isInteger(expr.value)) {
      if (expr.value < 1 || expr.value > outs.length)
        throw new SqlError(`ORDER BY ${expr.value}: there is no column ${expr.value}.`)
      return values[expr.value - 1]
    }
    if (expr.type === 'column' && !expr.table) {
      const at = outs.findIndex(out => out.name === expr.name)
      if (at >= 0 && (outputAliases.has(expr.name) || grouped)) return values[at]
    }
    return evaluate(expr, context)
  }
  if (grouped) {
    // GROUP BY 1 means the first column of the result.
    const groupBy = query.groupBy.map(expr => {
      if (expr.type !== 'literal' || typeof expr.value !== 'number' || !Number.isInteger(expr.value)) return expr
      if (expr.value < 1 || expr.value > outs.length)
        throw new SqlError(`GROUP BY ${expr.value}: there is no column ${expr.value}.`)
      return outs[expr.value - 1].expr
    })
    const groups = new Map<string, Bound[]>()
    for (const row of rows) {
      tick()
      const key = JSON.stringify(groupBy.map(expr => evaluate(expr, { row })))
      const group = groups.get(key)
      if (group) group.push(row)
      else groups.set(key, [row])
    }
    if (!groups.size && !query.groupBy.length) groups.set('[]', [])
    for (const group of groups.values()) {
      const context: Context = { row: group[0] || {}, group }
      if (query.having) {
        const keep = evaluate(query.having, context)
        if (keep === null || !truthy(keep)) continue
      }
      contexts.push(context)
    }
  } else {
    for (const row of rows) {
      tick()
      contexts.push({ row })
    }
  }
  // Window functions see the rows (or groups) after WHERE, GROUP BY and HAVING, before ORDER BY and LIMIT.
  contexts.forEach((context, index) => {
    context.index = index
  })
  const windows: (Expr & { type: 'window' })[] = []
  const collect = (expr: Expr) => {
    if (expr.type === 'window' && !windows.includes(expr)) windows.push(expr)
    exprParts(expr).exprs.forEach(collect)
  }
  outs.forEach(out => collect(out.expr))
  query.orderBy.forEach(item => {
    collect(item.expr)
    if (item.expr.type === 'column' && !item.expr.table && outputAliases.has(item.expr.name))
      collect(outputAliases.get(item.expr.name)!)
  })
  for (const window of windows) windowValues.set(window, computeWindow(window, contexts, evaluate, tick))
  for (const context of contexts) {
    const values = outs.map(out => evaluate(out.expr, context))
    lines.push({ values, keys: query.orderBy.map(item => orderValue(item.expr, context, values)) })
  }
  if (query.distinct) {
    const seen = new Set<string>()
    lines = lines.filter(line => {
      const key = JSON.stringify(line.values)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  if (query.orderBy.length)
    lines.sort((a, b) => {
      for (let index = 0; index < query.orderBy.length; index++) {
        const x = a.keys[index],
          y = b.keys[index]
        // Empty values go last, whichever way the column is sorted.
        if (x === null || y === null) {
          if (x !== y) return x === null ? 1 : -1
          continue
        }
        const order = sortCompare(x, y)
        if (order) return query.orderBy[index].desc ? -order : order
      }
      return 0
    })
  const start = query.offset || 0
  const end = query.limit === undefined ? lines.length : start + query.limit
  const picked = lines.slice(start, end)
  // Results inside a larger query keep every row; the final result is cut to SQL_LIMITS.resultRows in runQuery.
  const truncated = picked.length > SQL_LIMITS.workRows
  return {
    columns: outs.map(out => out.name),
    rows: picked
      .slice(0, SQL_LIMITS.workRows)
      .map(line => line.values.map(value => (typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value))),
    truncated,
    ms: Math.max(0, Math.round(now() - started)),
  }
}

/** Compares two ORDER BY keys: empty values last, each part ascending or descending. */
function compareKeys(a: SqlValue[], b: SqlValue[], order: OrderItem[]) {
  for (let index = 0; index < order.length; index++) {
    const x = a[index],
      y = b[index]
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1
      continue
    }
    const result = sortCompare(x, y)
    if (result) return order[index].desc ? -result : result
  }
  return 0
}

/** One window function's value for every row (or group), in the same order as the rows. */
function computeWindow(
  node: Expr & { type: 'window' },
  contexts: Context[],
  evaluate: (expr: Expr, context: Context) => SqlValue,
  tick: (count?: number) => void,
): SqlValue[] {
  const values: SqlValue[] = new Array(contexts.length).fill(null)
  const partitions = new Map<string, number[]>()
  contexts.forEach((context, index) => {
    tick()
    const key = JSON.stringify(node.partition.map(expr => evaluate(expr, context)))
    const list = partitions.get(key)
    if (list) list.push(index)
    else partitions.set(key, [index])
  })
  const name = node.call.name
  const arg = (index: number, at = 0) => (node.call.args[at] ? evaluate(node.call.args[at], contexts[index]) : null)
  for (const members of partitions.values()) {
    const keys = new Map(members.map(index => [index, node.order.map(item => evaluate(item.expr, contexts[index]))]))
    const sorted = node.order.length
      ? [...members].sort((a, b) => compareKeys(keys.get(a)!, keys.get(b)!, node.order) || a - b)
      : members
    const peers = (a: number, b: number) =>
      !node.order.length || compareKeys(keys.get(a)!, keys.get(b)!, node.order) === 0
    // With ORDER BY, the frame runs from the first row to the current row and its ties; without, the whole partition.
    const frameEnd = (position: number) => {
      let end = position
      if (!node.order.length) return sorted.length - 1
      while (end + 1 < sorted.length && peers(sorted[end + 1], sorted[position])) end++
      return end
    }
    tick(sorted.length)
    if (name === 'row_number') sorted.forEach((index, position) => (values[index] = position + 1))
    else if (name === 'rank' || name === 'dense_rank') {
      let rank = 0
      let dense = 0
      sorted.forEach((index, position) => {
        if (position === 0 || !peers(sorted[position - 1], index)) {
          rank = position + 1
          dense++
        }
        values[index] = name === 'rank' ? rank : dense
      })
    } else if (name === 'ntile') {
      const buckets = Math.max(1, Math.floor(numeric(arg(sorted[0] ?? 0)) || 1))
      sorted.forEach((index, position) => (values[index] = Math.floor((position * buckets) / sorted.length) + 1))
    } else if (name === 'lag' || name === 'lead') {
      sorted.forEach((index, position) => {
        const step = node.call.args[1] ? Math.floor(numeric(arg(index, 1)) ?? 1) : 1
        const target = position + (name === 'lag' ? -step : step)
        values[index] =
          target >= 0 && target < sorted.length ? arg(sorted[target]) : node.call.args[2] ? arg(index, 2) : null
      })
    } else if (name === 'first_value') sorted.forEach(index => (values[index] = arg(sorted[0])))
    else if (name === 'last_value')
      sorted.forEach((index, position) => (values[index] = arg(sorted[frameEnd(position)])))
    else {
      // SUM, COUNT, AVG, MIN, MAX over the frame: running totals with ORDER BY, partition totals without.
      let position = 0
      const seen = new Set<string>()
      let count = 0
      let sum = 0
      let numbers = 0
      let best: SqlValue = null
      while (position < sorted.length) {
        const end = frameEnd(position)
        for (let at = position; at <= end; at++) {
          const index = sorted[at]
          if (node.call.star) {
            count++
            continue
          }
          const value = arg(index)
          if (value === null) continue
          if (node.call.distinct) {
            const id = JSON.stringify(value)
            if (seen.has(id)) continue
            seen.add(id)
          }
          count++
          const number = numeric(value)
          if (number !== null) {
            sum += number
            numbers++
          }
          const order = best === null ? null : compare(value, best)
          if (best === null || (order !== null && (name === 'min' ? order < 0 : order > 0))) best = value
        }
        const result =
          name === 'count'
            ? count
            : name === 'sum'
              ? numbers
                ? sum
                : null
              : name === 'avg'
                ? numbers
                  ? sum / numbers
                  : null
                : best
        for (let at = position; at <= end; at++) values[sorted[at]] = result
        position = end + 1
      }
    }
  }
  return values
}

/** Whether a word is part of SQL itself, so it cannot be a plain column name. */
export const isKeyword = (word: string) => KEYWORDS.has(word.toLowerCase())
/** A table or column name as it can be written in a query. */
export const quoteName = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) && !KEYWORDS.has(name) ? name : `"${name}"`)
/** A value written as SQL. */
export const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`
