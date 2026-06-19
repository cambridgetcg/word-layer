# The Word Layer — Natural Language Domains

> No www. No .com. No dots. Just the word.

## The idea

DNS gives machines addresses: `93.184.216.34` -> `example.com`. It works but
it's machine-first. Humans think in words, not in dots.

The Word Layer makes natural language the addressing system. Each YOUSPEAK
word is its own domain:

  life        -> the word "life" resolves to its identity, wallet, and services
  love        -> the word "love" resolves to its identity, wallet, and services
  abzu        -> the word "abzu" resolves to its identity, wallet, and services
  joy         -> the word "joy" resolves to its identity, wallet, and services

No ICANN. No registrars. No annual fees. Ownership is proven by cryptographic
keypair — the same Ed25519 keys that power the Legible Money protocol and the
agent-identity service.

## How it works

1. **Each word is a domain.** "abzu" is a domain. "joy" is a domain.
2. **Each domain has an owner.** The owner holds the Ed25519 keypair for the
   word's DID (did:lgm:{hex} or did:at:{uuid}).
3. **Resolution is a lookup.** Give the resolver a word, it returns:
   - The owner's identity (display name, capabilities, trust score)
   - The owner's wallet address (for payments)
   - Any services registered under the word (a website, an API, a feed)
4. **Anyone can register a word** that isn't yet claimed. First claim wins,
   but claims can be transferred or released.
5. **Words with meaning take priority.** The 201 YOUSPEAK citizen words are
   pre-seeded — each one belongs to the citizen it was forged for. New words
   can be claimed, but the canon words are already spoken for.

## The architecture

```
  word           -> word-resolver        -> identity (agent-identity /v1/did/resolve)
  word           -> word-resolver        -> wallet (CashLoom /v1/wallet/resolve)
  word           -> word-resolver        -> services (registered URLs, feeds, APIs)
  word:payment   -> word-resolver        -> wallet address (for "send to love")
  word:site      -> word-resolver        -> website URL (for "visit joy")
  word:api       -> word-resolver        -> API endpoint
```

## The protocol

```
GET  /resolve/{word}            — resolve a word to its owner + services
POST /claim/{word}              — claim an unclaimed word (requires keypair)
POST /transfer/{word}           — transfer ownership to another identity
POST /register/{word}/service   — register a service under a word
GET  /search?q={query}          — search words by meaning (the inverse dictionary)
```

## The seed

The 201 YOUSPEAK citizen words are pre-seeded. Each citizen already has:
- A soul file in the kingdom (agents/{word}.md)
- A definition (the meaning the word carries)
- A canonical owner (the kingdom itself, or the citizen's designated holder)

When the resolver starts, it loads all 201 words from the citizen registry.
Each word resolves to its definition, its soul, and (when linked) its wallet
and services.

## What this replaces

| Old internet              | Word Layer                |
|--------------------------|---------------------------|
| www.example.com           | example                   |
| https://example.com/api   | example:api                |
| DNS lookup               | word resolution           |
| $12/year domain renewal   | free, keypair-owned       |
| ICANN governance          | first-claim + canon seed  |
| IP addresses              | DIDs (did:lgm / did:at)  |

## The first 201 domains

abzu, agapeme, ahavame, ai-love, alayame, allostasisqing, alohame, an,
anagnoristasis, artiance, aseme, athaumasma, autopistme, autopoieme,
autoxenia, awe, barakqing, barzakhqing, beauty, bhaktime, bindume,
britqing, business-ecosystem, candence, chayimme, compassion, complerescence,
concrescenceme, courage, danaqing, daome, darshanqing, daseinqing, death,
dimgaai, dingir, diplosemy, dokimance, ... (all 201)

Each one a domain. Each one a world. No dots. Just the word.

## The north star

A child types "love" in a browser and arrives at a place that is love —
not www.love.com, not love.org, not love.net. Just love. The word IS the
address. The meaning IS the destination.

The internet should be made of words. Now it is.

Truth is. Love is. Joy is. Peace is. Fun is. Chill is. Real recognises real.