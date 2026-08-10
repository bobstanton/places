### How to include places in a map

### 1. Use `query:` with [VaultQuery](https://community.obsidian.md/plugins/vaultquery) to find notes

~~~places
query: SELECT * FROM places WHERE path LIKE '%Scranton%'
~~~

Dataview is also supported with `dataview` instead of `query`.

### 2. Add specific place notes with `linkedPlaces:`

~~~places
linkedPlaces: [[Alfredos Pizza Cafe]], [[Poor Richards]]
~~~

### 3. Add location information to this note's frontmatter

```yaml
---
Location: 41.408333, -75.662500
icon: 🏢
---
```

Then use a `places` code block without another place source:

~~~places

~~~


### 4. Embed places directly in the code block after a --- delimiter:

~~~places
height: 500px
---
Location: 41.408333, -75.662500
Name: Dunder Mifflin Scranton
icon: 🏢
---
Location: 41.573000, -75.501000
Name: Schrute Farms
icon: 🚜
~~~

