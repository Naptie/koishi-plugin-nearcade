# koishi-plugin-nearcade

[![npm](https://img.use-npm.com/badge/npm/v/koishi-plugin-nearcade?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-nearcade)

The official Koishi plugin for nearcade.

## Features

- Arcade discovery: share a location card (QQ `LocationShare`) in a group and the bot replies with
  nearby arcades — rendered as a labeled map image (collision-aware labels with shop name,
  live attendance and metro line badges, metro lines & stations, walking paths, radius circle,
  scale bar) followed by a numbered text list matching the markers on the map.
- Attendance reporting and querying for registered arcades.
- Per-channel discovery settings (`nearcade.discover`), privacy, search and binding commands.
- Unbound-arcade autosearch (`nearcade.autosearch`): report attendance at any registered arcade
  by typing its name plus a count without binding it first.
