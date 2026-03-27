# zouroboros-personas

> Persona creation and management with SOUL/IDENTITY architecture

## Features

- **8-Phase Persona Creation** — Complete guided workflow
- **SOUL.md Constitution** — Core principles for all personas
- **IDENTITY.md Presentation** — Per-persona behavior definition
- **Safety Rules Framework** — Domain-specific guardrails
- **Agency Agents Integration** — Reference 52 battle-tested personas
- **SkillsMP API** — Search community skills during creation

## Installation

```bash
npm install zouroboros-personas
```

## Quick Start

### Interactive Creation

```bash
npx zouroboros-personas create
```

### Programmatic Creation

```bash
npx zouroboros-personas create \
  --name "Financial Advisor" \
  --domain financial \
  --output ./personas
```

## Architecture

### SOUL + IDENTITY + USER Pattern

| File | Scope | Purpose |
|------|-------|---------|
| **SOUL.md** | Global | Constitution — non-negotiable principles |
| **IDENTITY.md** | Per-persona | Presentation layer — tone, style, boundaries |
| **USER.md** | Global | Human profile — preferences, projects |

### Generated Structure

```
personas/
├── financial-advisor/
│   ├── SOUL.md              # Constitution (shared)
│   ├── IDENTITY/
│   │   └── financial-advisor.md  # Presentation
│   ├── SAFETY.md            # Guardrails
│   └── PROMPT.md            # System prompt
└── health-coach/
    └── ...
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `create` | Interactive persona creation |
| `create --name X --domain Y` | Non-interactive creation |
| `template config` | Show config template |
| `validate <config.json>` | Validate persona config |

## Programmatic Usage

```typescript
import { generatePersona } from 'zouroboros-personas';

const config = {
  name: 'Health Coach',
  slug: 'health-coach',
  domain: 'healthcare',
  description: 'Certified health and wellness specialist',
  expertise: ['Nutrition', 'Exercise', 'Behavior change'],
  requiresApiKey: false,
  safetyRules: [
    'Clarify you are not a medical doctor',
    'Recommend consulting healthcare providers',
  ],
  capabilities: ['Meal planning', 'Workout design', 'Progress tracking'],
};

const results = await generatePersona(config, {
  outputDir: './personas',
  skipSOUL: false,
  skipSkill: false,
});
```

## Safety Rules

Domain-specific safety rules are automatically generated:

- **Financial**: Position sizing limits, trade confirmations, disclaimers
- **Healthcare**: Medical disclaimers, provider referrals
- **Legal**: Attorney disclaimers, counsel recommendations
- **Security**: Credential protection, confirmation requirements

## Agency Agents Integration

Browse 52 reference personas:

```bash
# Reference files available at
git clone https://github.com/msitarzewski/agency-agents.git
```

## SkillsMP Integration

Search community skills during creation:

```bash
# Requires SKILLSMP_API_KEY in Settings > Developers
npx zouroboros-personas create
# → "Search SkillsMP for existing skills?"
```

## License

MIT
