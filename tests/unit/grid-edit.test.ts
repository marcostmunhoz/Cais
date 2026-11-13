import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '@shared/dialects/mysql';
import { buildUpdate, quoteLiteral, valueKind } from '@shared/dialects/mysql/literals';
import {
  buildGridUpdates,
  cellLock,
  gridEditability,
  parseCellInput,
  pendingCount,
  remapCells,
  sameCell,
  type EditTarget,
} from '@shared/grid';
import { render } from '@shared/i18n';
import type { CellValue, ColumnMeta, SchemaTable, SchemaTree } from '@shared/results';

// The UPDATEs the grid generates, and when a result can be edited at all.

/** The generated statement must read as exactly one plain UPDATE to the Cais itself. */
function expectOneUpdate(sql: string): void {
  const parts = mysqlDialect.splitStatements(sql + ';');
  expect(parts).toHaveLength(1);
  expect(parts[0]!.text).toBe(sql);
  const c = mysqlDialect.classify(sql);
  expect(c.kind).toBe('write');
  expect(c.verb).toBe('UPDATE');
  expect(c.executableComment).toBeUndefined();
  expect(mysqlDialect.warnings(sql)).toEqual([]);
}

const update = (value: CellValue, type = 'varchar(200)') =>
  buildUpdate({ database: 'app', table: 'people', set: [{ column: 'name', type, value }], where: [{ column: 'id', type: 'int', value: 7 }] });

describe('quoteLiteral (MySQL)', () => {
  it.each<[CellValue, string, string]>([
    [null, 'varchar(10)', 'NULL'],
    ['Ana', 'varchar(10)', "'Ana'"],
    ['', 'varchar(10)', "''"],
    ["d'Ávila", 'varchar(10)', "'d''Ávila'"],
    ["''", 'text', "''''''"],
    ['olá 👋', 'text', "'olá 👋'"],
    ['a;b', 'text', "'a;b'"],
    ['`x`', 'text', "'`x`'"],
    ['/*! DROP TABLE t */', 'text', "'/*! DROP TABLE t */'"],
    ['-- x', 'text', "'-- x'"],
    ['# x', 'text', "'# x'"],
    ['"x"', 'text', `'"x"'`],
    ['a\\b', 'text', "_utf8mb4 X'615c62'"],
    ["\\'", 'text', "_utf8mb4 X'5c27'"],
    ['a\nb', 'text', "_utf8mb4 X'610a62'"],
    ['a\tb', 'text', "_utf8mb4 X'610962'"],
    ['a\u0000b', 'text', "_utf8mb4 X'610062'"],
    ['\u202Eabc', 'text', "_utf8mb4 X'e280ae616263'"],
    ['é\n😀', 'text', "_utf8mb4 X'c3a90af09f9880'"],
    [5, 'int', '5'],
    [-5, 'int(11)', '-5'],
    ['9007199254740993', 'bigint', '9007199254740993'],
    ['18446744073709551615', 'bigint unsigned', '18446744073709551615'],
    ['-12', 'smallint', '-12'],
    [2026, 'year', '2026'],
    ['12.50', 'decimal(10,2)', '12.50'],
    ['-0.001', 'decimal(10,3)', '-0.001'],
    ['.5', 'decimal', '.5'],
    [1.5, 'double', '1.5'],
    [1e21, 'double', '1e+21'],
    ['1.5e-3', 'float', '1.5e-3'],
    ['ativo', "enum('ativo','inativo')", "'ativo'"],
    ['1', "enum('1','2')", "'1'"],
    ['a,b', "set('a','b')", "'a,b'"],
    [{ kind: 'binary', hex: '05', length: 1 }, 'bit(8)', "b'00000101'"],
    [{ kind: 'binary', hex: '0102', length: 2 }, 'bit', "b'0000000100000010'"],
    [{ kind: 'binary', hex: 'DEADbeef', length: 4 }, 'varbinary(16)', "X'deadbeef'"],
    [{ kind: 'binary', hex: '', length: 0 }, 'blob', "X''"],
    ['{"a": "b\\"c"}', 'json', `_utf8mb4 X'${Buffer.from('{"a": "b\\"c"}').toString('hex')}'`],
    ['{"a": 1}', 'json', `'{"a": 1}'`],
    ['2026-11-12 10:00:00.123456', 'datetime(6)', "'2026-11-12 10:00:00.123456'"],
  ])('%j as %s → %s', (value, type, expected) => {
    expect(quoteLiteral(value, type)).toBe(expected);
  });

  it.each<[CellValue, string]>([
    ['1 OR 1=1', 'int'],
    ['5; DROP TABLE t', 'bigint'],
    ['--5', 'int'],
    ['1e5', 'int'],
    ['', 'int'],
    [' 5', 'int'],
    ['1.5', 'int'],
    ['abc', 'decimal(10,2)'],
    ['1,5', 'decimal(10,2)'],
    ['1e5', 'decimal'],
    ['0x10', 'double'],
    [Number.NaN, 'double'],
    [Number.POSITIVE_INFINITY, 'double'],
    ['2', 'bit(8)'],
    [{ kind: 'binary', hex: 'ab', length: 300 }, 'blob'],
    [{ kind: 'binary', hex: 'zz', length: 1 }, 'varbinary(4)'],
    ['POINT(1 1)', 'geometry'],
    ['[1,2]', 'vector(2)'],
  ])('refuses %j as %s', (value, type) => {
    expect(() => quoteLiteral(value, type)).toThrow();
  });

  it('classifies types', () => {
    expect(valueKind('bigint unsigned')).toBe('integer');
    expect(valueKind('tinyint(1)')).toBe('integer');
    expect(valueKind('decimal(10,2)')).toBe('decimal');
    expect(valueKind('double')).toBe('float');
    expect(valueKind('bit(1)')).toBe('bit');
    expect(valueKind('varbinary(16)')).toBe('binary');
    expect(valueKind('longblob')).toBe('binary');
    expect(valueKind("enum('a')")).toBe('text');
    expect(valueKind('json')).toBe('text');
    expect(valueKind('point')).toBe('unsupported');
  });
});

describe('buildUpdate (MySQL)', () => {
  it('qualifies the table, sets by column name and matches the whole key, without LIMIT', () => {
    const sql = buildUpdate({
      database: 'app',
      table: 'order_items',
      set: [
        { column: 'qty', type: 'int', value: '3' },
        { column: 'note', type: 'text', value: null },
      ],
      where: [
        { column: 'order_id', type: 'bigint', value: '9007199254740993' },
        { column: 'sku', type: 'varchar(20)', value: 'A-1' },
      ],
    });
    expect(sql).toBe("UPDATE `app`.`order_items` SET `qty` = 3, `note` = NULL WHERE `order_id` = 9007199254740993 AND `sku` = 'A-1'");
    expect(sql).not.toMatch(/LIMIT/);
    expectOneUpdate(sql);
  });

  it.each<[string, CellValue, string?]>([
    ['quotes', "it's ''quoted'' '"],
    ['semicolons', "x'; DELETE FROM people; SELECT '"],
    ['backticks', '`; DROP TABLE people; `'],
    ['DELIMITER in the value', 'DELIMITER $$'],
    ['DELIMITER on its own line', 'x\nDELIMITER $$\nDROP TABLE t$$'],
    ['an executable comment', "/*!50000 DROP TABLE t */ ' /*!"],
    ['a comment opener', "'/* x"],
    ['a line comment', "-- '\n'; DROP TABLE t; -- "],
    ['backslash before a quote', "\\'; DROP TABLE t; -- "],
    ['backslash at the end', 'C:\\temp\\'],
    ['control characters', '\u0000\u0001\u001a\r\n\u007f'],
    ['bidi controls', 'abc\u202E\u2066def'],
    ['unicode', 'ação 中文 👩‍👩‍👧 \u2028'],
    ['a 4-byte character', '𝔘'],
    ['an empty string', ''],
    ['NULL', null],
    ['a JSON text', '{"a":"x\\ny","b":[1,2]}', 'json'],
    ['an ENUM', 'inativo', "enum('ativo','inativo')"],
    ['a decimal', '-123.4500', 'decimal(10,4)'],
    ['a big integer', '-9223372036854775808', 'bigint'],
    ['a binary value', { kind: 'binary', hex: '00ff27275c', length: 5 }, 'varbinary(10)'],
    ['a BIT value', { kind: 'binary', hex: '01', length: 1 }, 'bit(1)'],
  ])('one plain UPDATE with %s', (_label, value, type) => {
    expectOneUpdate(update(value, type));
  });

  it('quotes identifiers with backticks, newlines and semicolons', () => {
    const sql = buildUpdate({
      database: 'we`ird; db',
      table: 'ta`ble\nDELIMITER $$',
      set: [{ column: 'co;l`', type: 'text', value: 'x' }],
      where: [{ column: '`id', type: 'int', value: 1 }],
    });
    expect(sql).toBe("UPDATE `we``ird; db`.`ta``ble\nDELIMITER $$` SET `co;l``` = 'x' WHERE ```id` = 1");
    expectOneUpdate(sql);
  });

  it('refuses no SET, no key and a NULL key', () => {
    expect(() => buildUpdate({ database: 'a', table: 't', set: [], where: [{ column: 'id', type: 'int', value: 1 }] })).toThrow();
    expect(() => buildUpdate({ database: 'a', table: 't', set: [{ column: 'x', type: 'int', value: 1 }], where: [] })).toThrow();
    expect(() =>
      buildUpdate({ database: 'a', table: 't', set: [{ column: 'x', type: 'int', value: 1 }], where: [{ column: 'id', type: 'int', value: null }] }),
    ).toThrow();
  });

  it('splits several generated statements into one per row', () => {
    const stmts = [update("a'; b"), update('c\\'), update('DELIMITER //')];
    const parts = mysqlDialect.splitStatements(stmts.map((s) => s + ';').join('\n'));
    expect(parts.map((p) => p.text)).toEqual(stmts);
  });
});

// --- editability ---------------------------------------------------------------------------------

/** A result column of `table` as a fresh server reports it: type and key flag agree with the schema below. */
const src = (column: string, extra: Partial<ColumnMeta> = {}, table = 'people', alias = table): ColumnMeta => {
  const known = schema.databases[0]!.tables.find((t) => t.name.toLowerCase() === table.toLowerCase())?.columns.find(
    (c) => c.name.toLowerCase() === column.toLowerCase(),
  );
  return {
    name: column,
    type: known ? /^\s*([a-z]+)/i.exec(known.type)![1]!.toLowerCase() : 'varchar',
    source: { database: 'app', table, column, alias },
    primaryKeyPart: known?.key === 'PRI',
    nullable: known ? known.nullable : true,
    ...extra,
  };
};

const peopleTable: SchemaTable = {
  name: 'people',
  type: 'table',
  columns: [
    { name: 'id', type: 'int', nullable: false, key: 'PRI' },
    { name: 'name', type: 'varchar(50)', nullable: false },
    { name: 'email', type: 'varchar(80)', nullable: true },
    { name: 'upper_name', type: 'varchar(50)', nullable: true, generated: 'virtual' },
    { name: 'shape', type: 'geometry', nullable: true },
    { name: 'score', type: 'double', nullable: true },
    { name: 'avatar', type: 'varbinary(400)', nullable: true },
  ],
};
const schema: SchemaTree = {
  databases: [
    {
      name: 'app',
      tables: [
        peopleTable,
        { name: 'people_v', type: 'view', columns: [{ name: 'id', type: 'int', nullable: false }] },
        { name: 'no_key', type: 'table', columns: [{ name: 'a', type: 'int', nullable: true }] },
        {
          name: 'items',
          type: 'table',
          columns: [
            { name: 'order_id', type: 'bigint', nullable: false, key: 'PRI' },
            { name: 'line', type: 'int', nullable: false, key: 'PRI' },
            { name: 'qty', type: 'int', nullable: false },
          ],
        },
        { name: 'measures', type: 'table', columns: [{ name: 'v', type: 'double', nullable: false, key: 'PRI' }, { name: 'n', type: 'int', nullable: true }] },
        { name: 'blobs', type: 'table', columns: [{ name: 'k', type: 'varbinary(512)', nullable: false, key: 'PRI' }, { name: 'n', type: 'int', nullable: true }] },
        {
          name: 'readings',
          type: 'table',
          columns: [
            { name: 'sensor_id', type: 'int', nullable: false, key: 'PRI' },
            { name: 'ts', type: 'timestamp', nullable: false, key: 'PRI' },
            { name: 'v', type: 'decimal(8,2)', nullable: true },
            { name: 'seen', type: 'timestamp', nullable: true },
          ],
        },
        { name: 'Users', type: 'table', columns: [{ name: 'id', type: 'int', nullable: false, key: 'PRI' }, { name: 'name', type: 'varchar(50)', nullable: true }] },
      ],
    },
  ],
};

const read = (columns: ColumnMeta[], rows: CellValue[][]) => ({ kind: 'read' as const, verb: 'SELECT', columns, rows });
const editability = (columns: ColumnMeta[], rows: CellValue[][]) => gridEditability(read(columns, rows), schema, mysqlDialect.valueKind);
const reasonOf = (e: ReturnType<typeof editability>): string => (e.editable ? '' : render(e.reason));

describe('gridEditability', () => {
  it('a plain SELECT of one table with its key is editable, with the columns it can write', () => {
    const e = editability(
      [src('id'), src('name', { name: 'nome' }), { name: 'n2', type: 'bigint' }, src('upper_name'), src('shape', { type: 'geometry' }), src('name')],
      [[1, 'Ana', 2, 'ANA', null, 'Ana']],
    );
    expect(e.editable).toBe(true);
    if (!e.editable) return;
    expect(e.database).toBe('app');
    expect(e.table).toBe('people');
    expect(e.key).toEqual([{ index: 0, column: 'id', type: 'int' }]);
    expect(e.columns[0]).toMatchObject({ editable: true, column: 'id', kind: 'integer' });
    // aliased column: written by its real name
    expect(e.columns[1]).toMatchObject({ editable: true, column: 'name', type: 'varchar(50)', nullable: false });
    const lock = (i: number) => {
      const c = e.columns[i]!;
      return c.editable ? '' : render(c.reason);
    };
    expect(lock(2)).toBe('n2 é uma expressão, não uma coluna da tabela.');
    expect(lock(3)).toBe('upper_name é uma coluna gerada: o servidor calcula o valor.');
    expect(lock(4)).toBe('shape é do tipo geometry, que não é editável na grade.');
    expect(lock(5)).toBe('name aparece mais de uma vez no resultado: edite a primeira.');
  });

  it('an aliased table is still one table', () => {
    expect(editability([src('id', {}, 'people', 'p'), src('name', {}, 'people', 'p')], [[1, 'Ana']]).editable).toBe(true);
  });

  it('refuses a join and a self-join', () => {
    const join = editability([src('id'), src('id', { primaryKeyPart: true }, 'items')], [[1, 2]]);
    expect(reasonOf(join)).toBe('Edição na grade só para resultado de uma tabela (este vem de app.people, app.items).');
    const self = editability([src('id', {}, 'people', 'a'), src('id', {}, 'people', 'b')], [[1, 2]]);
    expect(reasonOf(self)).toBe('Edição na grade só para resultado de uma tabela (este vem de app.people (a), app.people (b)).');
  });

  it('refuses a view, expressions only, an unknown table, no key and a missing key column', () => {
    expect(reasonOf(editability([src('id', {}, 'people_v')], [[1]]))).toBe('app.people_v é uma view: edição na grade só em tabela.');
    expect(reasonOf(editability([{ name: 'price*2', type: 'decimal' }], [['2.00']]))).toBe(
      'Edição na grade só para resultado de uma tabela: as colunas deste resultado não vêm de uma tabela.',
    );
    expect(reasonOf(editability([src('id', {}, 'gone')], [[1]]))).toBe('A tabela app.gone não está no schema carregado. Atualize a árvore do ambiente.');
    expect(reasonOf(editability([src('a', {}, 'no_key')], [[1]]))).toBe('A tabela app.no_key não tem chave primária: a edição na grade precisa dela.');
    expect(reasonOf(editability([src('name')], [['Ana']]))).toBe(
      'Edição na grade só para resultado de uma tabela com a chave primária inteira (falta: id).',
    );
    expect(reasonOf(editability([src('order_id', {}, 'items'), src('qty', {}, 'items')], [[1, 2]]))).toBe(
      'Edição na grade só para resultado de uma tabela com a chave primária inteira (falta: line).',
    );
    // a key column that is an expression with the key's name does not count
    expect(reasonOf(editability([{ name: 'id', type: 'int' }, src('name')], [[1, 'Ana']]))).toBe(
      'Edição na grade só para resultado de uma tabela com a chave primária inteira (falta: id).',
    );
  });

  it('refuses while the schema loads, and a schema whose key is stale', () => {
    expect(reasonOf(gridEditability(read([src('id'), src('name')], [[1, 'Ana']]), undefined, mysqlDialect.valueKind))).toMatch(/^Carregando o schema/);
    const stale = editability([src('id'), src('email', { primaryKeyPart: true })], [[1, 'a@b']]);
    expect(reasonOf(stale)).toBe('A chave primária mudou desde que o schema foi carregado. Atualize a árvore do ambiente.');
  });

  it('refuses NULL, approximate, cut and repeated key values', () => {
    expect(reasonOf(editability([src('id'), src('name')], [[1, 'Ana'], [null, 'Bia']]))).toBe(
      'Há linha com a chave id em NULL: não dá para identificar a linha.',
    );
    expect(reasonOf(editability([src('v', {}, 'measures'), src('n', {}, 'measures')], [[1.5, 1]]))).toBe(
      'A chave v é FLOAT ou DOUBLE: a comparação não é exata.',
    );
    expect(reasonOf(editability([src('k', {}, 'blobs'), src('n', {}, 'blobs')], [[{ kind: 'binary', hex: 'ab', length: 400 }, 1]]))).toBe(
      'A chave k tem valor binário cortado na grade.',
    );
    expect(reasonOf(editability([src('id'), src('name')], [[1, 'Ana'], [1, 'Ana']]))).toBe(
      'A chave primária se repete no resultado: não dá para saber qual linha editar.',
    );
    // a composite key repeats only when every part repeats
    expect(editability([src('order_id', {}, 'items'), src('line', {}, 'items')], [['1', 1], ['1', 2]]).editable).toBe(true);
  });

  it('refuses errors and anything but a read', () => {
    const cols = [src('id'), src('name')];
    expect(reasonOf(gridEditability({ kind: 'write', verb: 'UPDATE', columns: cols, rows: [] }, schema, mysqlDialect.valueKind))).toBe(
      'Edição na grade só para o resultado de um SELECT.',
    );
    expect(gridEditability({ kind: 'read', verb: 'SHOW', columns: cols, rows: [] }, schema, mysqlDialect.valueKind).editable).toBe(false);
    expect(
      gridEditability({ kind: 'read', verb: 'SELECT', columns: cols, rows: [], error: { message: 'x' } }, schema, mysqlDialect.valueKind).editable,
    ).toBe(false);
    expect(gridEditability({ kind: 'read', verb: 'TABLE', columns: cols, rows: [[1, 'a']] }, schema, mysqlDialect.valueKind).editable).toBe(true);
  });

  it('matches table and column names without case only when unambiguous', () => {
    expect(editability([src('ID', {}, 'PEOPLE'), src('NAME', {}, 'PEOPLE')], [[1, 'a']]).editable).toBe(true);
  });

  // a stale cached schema must never produce a WHERE that matches several rows
  it('refuses a key the server no longer flags, and a key whose type changed (stale schema)', () => {
    const stale = 'A chave primária mudou desde que o schema foi carregado. Atualize a árvore do ambiente.';
    // the key moved: the server says id is not part of the key any more
    expect(reasonOf(editability([src('id', { primaryKeyPart: false }), src('name')], [[5, 'x']]))).toBe(stale);
    // composite key: one part no longer flagged
    expect(reasonOf(editability([src('order_id', {}, 'items'), src('line', { primaryKeyPart: false }, 'items'), src('qty', {}, 'items')], [[1, 1, 1]]))).toBe(stale);
    // no flags reported at all (undefined) is not a refusal
    expect(editability([src('id', { primaryKeyPart: undefined }), src('name')], [[5, 'x']]).editable).toBe(true);
    // the key is VARCHAR now: '05' must never be written as the number 05
    const e = editability([src('id', { type: 'varchar' }), src('name')], [['05', 'x']]);
    expect(reasonOf(e)).toBe(stale);
  });

  it('locks a column whose type changed since the schema was read', () => {
    const e = editability([src('id'), src('name', { type: 'int' })], [[1, '007']]);
    expect(e.editable).toBe(true);
    if (!e.editable) return;
    const c = e.columns[1]!;
    expect(c.editable ? '' : render(c.reason)).toBe('O tipo de name mudou desde que o schema foi carregado. Atualize a árvore do ambiente.');
  });

  it('result types and schema types of a fresh schema map to the same kind', () => {
    // what the driver reports (values.ts typeName) next to what information_schema says (COLUMN_TYPE)
    const pairs: [string, string][] = [
      ['char', "enum('a','b')"], ['char', "set('a','b')"], ['enum', "enum('a')"], ['set', "set('a')"], ['bit', 'bit(8)'],
      ['year', 'year'], ['json', 'json'], ['text', 'text'], ['mediumtext', 'mediumtext'], ['blob', 'blob'], ['longblob', 'longblob'],
      ['varbinary', 'varbinary(16)'], ['binary', 'binary(16)'], ['tinyint', 'tinyint(1)'], ['int', 'int unsigned'], ['bigint', 'bigint unsigned'],
      ['decimal', 'decimal(10,2)'], ['double', 'double'], ['float', 'float'], ['date', 'date'], ['datetime', 'datetime(6)'], ['time', 'time'],
      ['timestamp', 'timestamp(3)'], ['varchar', 'varchar(20)'], ['char', 'char(3)'],
    ];
    for (const [reported, declared] of pairs) expect([reported, valueKind(reported)]).toEqual([reported, valueKind(declared)]);
  });

  it('refuses a TIMESTAMP key: its text depends on the session time zone', () => {
    expect(valueKind('timestamp')).toBe('zoned');
    expect(valueKind('datetime')).toBe('text');
    expect(reasonOf(editability([src('sensor_id', {}, 'readings'), src('ts', {}, 'readings'), src('v', {}, 'readings')], [[1, '2026-11-01 01:30:00', '1.00']]))).toBe(
      'A chave ts é TIMESTAMP: o valor depende do fuso horário da sessão.',
    );
    // a TIMESTAMP column that is not the key stays editable, quoted as text
    const e = editability([src('id'), src('name')], [[1, 'a']]);
    expect(e.editable).toBe(true);
    expect(quoteLiteral('2026-11-01 01:30:00', 'timestamp')).toBe("'2026-11-01 01:30:00'");
  });

  it('the UPDATE names the table the server reported, never a case variant from the schema', () => {
    // the schema was read when only `Users` existed; the rows come from `users` (lower_case_table_names=0)
    const e = editability([src('id', {}, 'users'), src('name', {}, 'users')], [[7, 'a']]);
    expect(e.editable).toBe(true);
    if (!e.editable) return;
    expect(e.table).toBe('users');
    expect(buildGridUpdates(mysqlDialect, e, [[7, 'a']], { 0: { 1: 'x' } })[0]!.sql).toBe("UPDATE `app`.`users` SET `name` = 'x' WHERE `id` = 7");
  });

  it('locks a cut binary cell', () => {
    const e = editability([src('id'), src('avatar')], [[1, { kind: 'binary', hex: 'ab', length: 400 }]]);
    expect(render(cellLock(e, 1, { kind: 'binary', hex: 'ab', length: 400 })!)).toBe('O valor binário está cortado na grade: não dá para editá-lo.');
    expect(cellLock(e, 1, 'x')).toBeNull();
  });
});

describe('grid edits to UPDATEs', () => {
  const e = editability([src('id'), src('name', { name: 'nome' }), src('email')], [
    [1, 'Ana', 'ana@x'],
    [2, 'Bia', null],
    [3, 'Caio', 'c@x'],
  ]) as EditTarget;
  const rows: CellValue[][] = [
    [1, 'Ana', 'ana@x'],
    [2, 'Bia', null],
    [3, 'Caio', 'c@x'],
  ];

  it('one UPDATE per edited row, in row order', () => {
    const updates = buildGridUpdates(mysqlDialect, e, rows, { 2: { 1: "Caio d'Ávila" }, 0: { 2: null, 1: 'Ana\\B' } });
    expect(updates.map((u) => u.row)).toEqual([0, 2]);
    const sql = updates.map((u) => u.sql);
    expect(sql).toEqual([
      "UPDATE `app`.`people` SET `name` = _utf8mb4 X'416e615c42', `email` = NULL WHERE `id` = 1",
      "UPDATE `app`.`people` SET `name` = 'Caio d''Ávila' WHERE `id` = 3",
    ]);
    expect(mysqlDialect.splitStatements(sql.map((s) => s + ';').join('\n'))).toHaveLength(2);
    expect(pendingCount({ 2: { 1: 'x' }, 0: { 2: null, 1: 'y' } })).toEqual({ changes: 3, rows: 2 });
  });

  it('parses what the person typed by column type', () => {
    const intCol = { editable: true as const, column: 'id', type: 'int', kind: 'integer' as const, nullable: false };
    expect(parseCellInput(' 42 ', intCol, mysqlDialect)).toEqual({ value: '42' });
    expect('error' in parseCellInput('4 2', intCol, mysqlDialect)).toBe(true);
    const textCol = { editable: true as const, column: 'name', type: 'varchar(5)', kind: 'text' as const, nullable: true };
    expect(parseCellInput('', textCol, mysqlDialect)).toEqual({ value: '' });
    expect(parseCellInput(' a ', textCol, mysqlDialect)).toEqual({ value: ' a ' });
    const bin = { editable: true as const, column: 'k', type: 'varbinary(4)', kind: 'binary' as const, nullable: true };
    expect(parseCellInput('0xDEAD', bin, mysqlDialect)).toEqual({ value: { kind: 'binary', hex: 'dead', length: 2 } });
    expect('error' in parseCellInput('abc', bin, mysqlDialect)).toBe(true);
  });

  it('compares typed values with the server values', () => {
    expect(sameCell(5, '5')).toBe(true);
    expect(sameCell('', null)).toBe(false);
    expect(sameCell(null, null)).toBe(true);
    expect(sameCell({ kind: 'binary', hex: 'AB', length: 1 }, { kind: 'binary', hex: 'ab', length: 1 })).toBe(true);
  });

  it('moves pending edits onto a refreshed result by key', () => {
    const fresh: CellValue[][] = [
      [3, 'Caio', 'c@x'],
      [1, 'Ana', 'ana@x'],
    ];
    expect(remapCells(e.key, rows, fresh, { 0: { 1: 'x' }, 1: { 1: 'y' }, 2: { 2: 'z' } })).toEqual({ 1: { 1: 'x' }, 0: { 2: 'z' } });
  });
});

describe('gridEditability: engine capability', () => {
  const result = read([src('id'), src('name')], [[1, 'Ana']]);
  it('an engine without grid editing gives its own reason, before any other', () => {
    const e = gridEditability(result, schema, mysqlDialect.valueKind, { gridEdit: false, name: 'Motor X' });
    expect(e.editable).toBe(false);
    expect(reasonOf(e)).toBe('Nesta versão o Motor X é só leitura.');
    expect(reasonOf(gridEditability({ kind: 'ddl', verb: 'CREATE' }, schema, mysqlDialect.valueKind, { gridEdit: false, name: 'Motor X' }))).toBe(
      'Nesta versão o Motor X é só leitura.',
    );
  });
  it('an engine with grid editing, or none given, edits as before', () => {
    expect(gridEditability(result, schema, mysqlDialect.valueKind, { gridEdit: true, name: 'MySQL' }).editable).toBe(true);
    expect(gridEditability(result, schema, mysqlDialect.valueKind).editable).toBe(true);
  });
});
