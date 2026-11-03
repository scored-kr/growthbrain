import { evaluate,measure } from './retrieval-quality.mjs';
console.log(JSON.stringify({...evaluate(),performance:measure()},null,2));
