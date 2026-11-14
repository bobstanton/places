### How to include places in a map

### 1. Use `query:` with [VaultQuery](https://community.obsidian.md/plugins/vaultquery) to find notes

~~~places
query: SELECT * FROM places WHERE path LIKE '%Scranton%'
~~~

Dataview is also supported with `dataview` instead of `query`.

### 2. Use `places:` with links or details

~~~places
places:
  - [[Alfredos Pizza Cafe]]
  - [[Poor Richards]]
  - location: 41.408333, -75.662500
    name: Dunder Mifflin Scranton
    icon: 🏢
  - location: 41.573000, -75.501000
    name: Schrute Farms
    icon: 🚜
~~~

### 3. Add location information to this note's frontmatter

```yaml
---
Location: 41.408333, -75.662500
icon: 🏢
---
```

Then use a `places` code block without other sources:

~~~places

~~~
