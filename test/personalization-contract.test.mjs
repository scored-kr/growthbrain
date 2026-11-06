import test from 'node:test';
import assert from 'node:assert/strict';
import {runPersonalizationContracts} from './personalization-contract.mjs';
test('P01–P13 engine obligations pass without claiming model acceptance or baseline improvement',async()=>{
 const report=await runPersonalizationContracts();assert.equal(report.enginePassed,13);assert.equal(report.actualAiOutputs,0);
});
