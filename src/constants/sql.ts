// SQL keywords for query/dataview highlighting
export const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
  'like', 'between', 'exists', 'case', 'when', 'then', 'else', 'end',
  'as', 'on', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full',
  'union', 'all', 'distinct', 'group', 'by', 'having', 'order', 'asc', 'desc',
  'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'create', 'table', 'drop', 'alter', 'index', 'primary', 'key', 'foreign',
  'with', 'recursive', 'over', 'partition', 'row', 'rows', 'range',
  'true', 'false'
]);

// SQL/DQL functions for query/dataview highlighting
export const SQL_FUNCTIONS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'cast',
  'substr', 'substring', 'length', 'upper', 'lower', 'trim', 'ltrim', 'rtrim',
  'replace', 'instr', 'printf', 'typeof', 'abs', 'round', 'random',
  'date', 'time', 'datetime', 'julianday', 'strftime', 'now',
  'ifnull', 'iif', 'glob', 'hex', 'quote', 'zeroblob',
  'total', 'group_concat', 'json', 'json_extract', 'json_array', 'json_object',
  'contains', 'file', 'link', 'list', 'sort', 'flat', 'reverse'
]);
