export const importMaxBytes=8*1024*1024;
export const importMaxRows=10000;
export type ImportFormat='CSV'|'XLSX'|'XLS';
export type ParsedSheet={index:number;name:string;headers:string[];headerRow:number;rows:{number:number;cells:(string|null)[]}[]};
export type ParsedImport={sheets:ParsedSheet[];rowCount:number};
export class ImportParseError extends Error {constructor(public code:string){super(code);}}
