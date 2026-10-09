function mulberry32(a) {
            return function () {
                a |= 0; a = a + 0x6D2B79F5 | 0;
                let t = Math.imul(a ^ a >>> 15, 1 | a);
                t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
                return ((t ^ t >>> 14) >>> 0) / 4294967296;
            };
        }

        // Bot loadouts depend only on the arena number so every client builds identical bots from the shared seed.
        function chooseBotWeaponId(arenaNum) {
            const ids = Object.keys(WEAPONS);
            const center = Math.min(ids.length - 1, arenaNum);
            const lo = Math.max(0, center - 2), hi = Math.min(ids.length - 1, center + 2);
            return ids[lo + Math.floor(Math.random() * (hi - lo + 1))];
        }

        function chooseBotTrackLevel(arenaNum) {
            const center = Math.min(TRACKS_UPGRADES.length, 1 + Math.floor(arenaNum / 2));
            const lo = Math.max(1, center - 2), hi = Math.min(TRACKS_UPGRADES.length, center + 2);
            return lo + Math.floor(Math.random() * (hi - lo + 1));
        }

        function chooseBotSkin() {
            const totalWeight = SKINS.reduce((total, skin) => total + 1 / (1 + skin.cost / 1000), 0);
            let selection = Math.random() * totalWeight;
            for (const skin of SKINS) {
                selection -= 1 / (1 + skin.cost / 1000);
                if (selection <= 0) return skin.id;
            }
            return SKINS[0].id;
        }

        const JUG_STATS = { radius: 44, hp: 2500, dmgMult: 3, speedMult: 1.25 };

        // roster: 25 entries (human {id,name,weapon,skin,trackLevel,maxHp} or null for a BOT). mySlot: this client's slot.
        // mode: 'br' battle royale, 'tdm' teams, 'ctf' capture the flag, 'jug' juggernaut.
        function generateArena(arenaNum, seed, roster, mySlot, mode, jugId) {
            mode = mode || 'br';
            const realRandom = Math.random;
            Math.random = mulberry32(seed || 1);
            try {
                walls = []; barrels = []; powerups = []; tanks = []; bullets = []; particles = []; scrapDrops = [];
                const teamMode = mode !== 'br';
                arenaBoundary = teamMode
                    ? { x: 0, y: 0, w: WORLD_WIDTH, h: WORLD_HEIGHT, shrinkRate: 0 }
                    : { x: 100, y: 100, w: WORLD_WIDTH - 200, h: WORLD_HEIGHT - 200, shrinkRate: 0.1 + (arenaNum * 0.02) };

                const bases = { red: { x: 380, y: WORLD_HEIGHT / 2 }, blue: { x: WORLD_WIDTH - 380, y: WORLD_HEIGHT / 2 } };
                mp.bases = bases;
                const nearBase = (x, y, r) => teamMode && (Math.hypot(x - bases.red.x, y - bases.red.y) < r || Math.hypot(x - bases.blue.x, y - bases.blue.y) < r);
                const area = (WORLD_WIDTH * WORLD_HEIGHT) / (3000 * 2200);

                const wallThickness = 18;
                walls.push({ x: 0, y: 0, w: WORLD_WIDTH, h: wallThickness, destructible: false });
                walls.push({ x: 0, y: WORLD_HEIGHT - wallThickness, w: WORLD_WIDTH, h: wallThickness, destructible: false });
                walls.push({ x: 0, y: 0, w: wallThickness, h: WORLD_HEIGHT, destructible: false });
                walls.push({ x: WORLD_WIDTH - wallThickness, y: 0, w: wallThickness, h: WORLD_HEIGHT, destructible: false });

                const numObstacles = Math.round((22 + Math.min(arenaNum * 3, 12)) * area);
                for (let i = 0; i < numObstacles; i++) {
                    const isVertical = Math.random() > 0.5;
                    const w = isVertical ? 22 : (140 + Math.random() * 160);
                    const h = isVertical ? (140 + Math.random() * 160) : 22;
                    const x = 300 + Math.random() * (WORLD_WIDTH - 600 - w);
                    const y = 300 + Math.random() * (WORLD_HEIGHT - 600 - h);
                    const destructible = Math.random() > 0.35;
                    if (Math.hypot(x + w / 2 - WORLD_WIDTH / 2, y + h / 2 - WORLD_HEIGHT / 2) < 400) continue;
                    if (teamMode && (checkRectCollision(bases.red.x, bases.red.y, 330, { x, y, w, h }) || checkRectCollision(bases.blue.x, bases.blue.y, 330, { x, y, w, h }))) continue;
                    walls.push({ x, y, w, h, destructible, hp: 120, maxHp: 120 });
                }

                const numBarrels = Math.round((18 + arenaNum * 2) * area);
                let barrelId = 0;
                for (let i = 0; i < numBarrels; i++) {
                    const bx = 300 + Math.random() * (WORLD_WIDTH - 600);
                    const by = 300 + Math.random() * (WORLD_HEIGHT - 600);
                    if (Math.hypot(bx - WORLD_WIDTH / 2, by - WORLD_HEIGHT / 2) < 300 || nearBase(bx, by, 320)) continue;
                    barrels.push({ id: barrelId++, x: bx, y: by, radius: 18, hp: 1, maxHp: 1 });
                }

                const SLOTS = 25;
                // ring spawn points (battle royale starts + juggernaut-mode hunter spawns)
                const ring = [];
                const cx = WORLD_WIDTH / 2, cy = WORLD_HEIGHT / 2;
                for (let i = 0; i < SLOTS; i++) {
                    let placed = false, attempts = 0;
                    while (!placed && attempts < 150) {
                        attempts++;
                        const angle = (i / SLOTS) * Math.PI * 2 + (Math.random() * 0.3);
                        const ex = cx + Math.cos(angle) * (1200 + Math.random() * 450);
                        const ey = cy + Math.sin(angle) * (800 + Math.random() * 350);
                        if (ex > 250 && ex < WORLD_WIDTH - 250 && ey > 250 && ey < WORLD_HEIGHT - 250 && isPositionClear(ex, ey, 30)) {
                            ring.push({ x: ex, y: ey }); placed = true;
                        }
                    }
                    if (!placed) ring.push({ x: 300 + (i % 5) * 120, y: WORLD_HEIGHT - 330 - Math.floor(i / 5) * 90 });
                }
                mp.ringPoints = ring;

                const teamIndex = { red: 0, blue: 0 };
                let bossAssigned = false;
                for (let i = 0; i < SLOTS; i++) {
                    const human = roster && roster[i];
                    const isMe = i === mySlot;
                    const isJug = mode === 'jug' && ((isMe && jugId === mp.myId) || (human && human.id === jugId));
                    let team = null;
                    if (mode === 'tdm' || mode === 'ctf') team = i % 2 ? 'blue' : 'red';
                    else if (mode === 'jug') team = isJug ? 'red' : 'blue';
                    // spawn position
                    let spawn;
                    if (mode === 'tdm' || mode === 'ctf') {
                        const k = teamIndex[team]++;
                        spawn = { x: bases[team].x + ((k % 4) - 1.5) * 62, y: bases[team].y + (Math.floor(k / 4) - 1.5) * 62 };
                    } else if (isJug) spawn = { x: cx, y: cy };
                    else spawn = ring[i];

                    if (isMe) {
                        player = {
                            id: mp.myId, name: mp.displayName(), team,
                            x: spawn.x, y: spawn.y, radius: 24, angle: 0, turretAngle: 0,
                            speed: playerState.speed, hp: playerState.hp, maxHp: playerState.maxHp,
                            trackLevel: playerState.trackLevel, trackColor: TRACK_COLORS[playerState.trackLevel - 1],
                            flameFuel: 100, maxFlameFuel: 100, flameShotThisFrame: false,
                            lastShot: 0, color: SKINS.find(s => s.id === playerState.activeSkin)?.color || '#38bdf8', skin: playerState.activeSkin
                        };
                        if (isJug) { player.radius = JUG_STATS.radius; player.hp = player.maxHp = JUG_STATS.hp; player.jug = true; player.dmgMult = JUG_STATS.dmgMult; player.speedMult = JUG_STATS.speedMult; }
                    } else if (human) {
                        const lvl = Math.max(1, Math.min(TRACKS_UPGRADES.length, human.trackLevel | 0 || 1));
                        const tank = {
                            id: human.id, name: human.name, isHuman: true, type: 'human', team,
                            x: spawn.x, y: spawn.y, tx: spawn.x, ty: spawn.y, radius: 24, angle: 0, turretAngle: 0,
                            hp: human.maxHp, maxHp: human.maxHp, color: '#38bdf8',
                            weaponId: WEAPONS[human.weapon] ? human.weapon : 'starter', trackLevel: lvl, trackColor: TRACK_COLORS[lvl - 1],
                            skin: SKINS.some(s => s.id === human.skin) ? human.skin : 'standard', lastShot: 0, speed: 0
                        };
                        if (isJug) { tank.radius = JUG_STATS.radius; tank.hp = tank.maxHp = JUG_STATS.hp; tank.jug = true; }
                        tanks.push(tank);
                    } else {
                        if (mode === 'jug' && i === mySlot) continue;
                        const types = ['rusher', 'sniper', 'turret'];
                        if (arenaNum >= 2) types.push('boss');
                        let type = types[Math.floor(Math.random() * types.length)];
                        if (mode === 'br' && !bossAssigned && arenaNum >= 2) { type = 'boss'; bossAssigned = true; }
                        if (mode !== 'br' && type === 'boss') type = 'rusher';
                        const weaponId = chooseBotWeaponId(arenaNum);
                        const trackLevel = chooseBotTrackLevel(arenaNum);
                        const trackUpgrade = TRACKS_UPGRADES[trackLevel - 1];
                        const typeSpeedMultiplier = type === 'rusher' ? 1.06 : (type === 'boss' ? 0.53 : 0.66);
                        const weapon = WEAPONS[weaponId];
                        const hp = type === 'boss' ? 280 : (type === 'sniper' ? 70 : 110);
                        tanks.push({
                            id: 'b' + i, name: 'BOT', team, role: (i >> 1) % 2 ? 'defender' : 'attacker',
                            x: spawn.x, y: spawn.y, tx: spawn.x, ty: spawn.y,
                            radius: 24, angle: Math.random() * Math.PI * 2, turretAngle: 0,
                            speed: trackUpgrade.speed * typeSpeedMultiplier * (mode === 'br' ? 1 : 1.15), hp, maxHp: hp,
                            type, color: type === 'boss' ? '#ef4444' : (type === 'rusher' ? '#f97316' : (type === 'sniper' ? '#a855f7' : '#eab308')),
                            weaponId, trackLevel, trackColor: TRACK_COLORS[trackLevel - 1], skin: chooseBotSkin(),
                            lastShot: Date.now() + 3800 + Math.random() * 2500, shootInterval: Math.max(450, weapon.fireRate * (type === 'sniper' ? 1.5 : (type === 'boss' ? 0.85 : 1.15)))
                        });
                    }
                }
            } finally {
                Math.random = realRandom;
            }
            survivalTimer = 0;
            creditsEarnedThisRun = 0;
        }

        
