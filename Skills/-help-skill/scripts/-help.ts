#!/usr/bin/env bun
/**
 * --help Skill Script
 */

const API_KEY = process.env.GENERAL_API_KEY;

if (!API_KEY) {
  console.error("❌ Error: GENERAL_API_KEY not set");
  console.error("Add it in Settings > Developers");
  process.exit(1);
}

const BASE_URL = "https://api.general.com/v1";

async function fetchData(endpoint: string) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { "Authorization": `Bearer ${API_KEY}` }
  });
  
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  
  return response.json();
}

function help() {
  console.log(`
--help Skill

Usage: bun -help.ts <command> [options]

Commands:
  status    Check API connection
  search    Search for items
  get       Get specific item
  help      Show this help
`);
}

async function main() {
  const command = process.argv[2];
  
  if (!command || command === "help") {
    help();
    return;
  }
  
  try {
    switch (command) {
      case "status":
        console.log("✅ --help skill active");
        console.log("API Key:", API_KEY ? "Set" : "Missing");
        break;
        
      case "search":
        const query = process.argv[3];
        if (!query) {
          console.error("Usage: bun -help.ts search <query>");
          process.exit(1);
        }
        console.log(`Searching for: ${query}`);
        // Implement search
        break;
        
      case "get":
        const id = process.argv[3];
        if (!id) {
          console.error("Usage: bun -help.ts get <id>");
          process.exit(1);
        }
        console.log(`Getting item: ${id}`);
        // Implement get
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        help();
        process.exit(1);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
