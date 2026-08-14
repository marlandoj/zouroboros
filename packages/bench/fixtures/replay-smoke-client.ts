const response = await fetch('https://fixture.local/v1/value?api_key=test-fixture-key');
const data = await response.json() as { value: string };
console.log(`fixture:${data.value}`);
