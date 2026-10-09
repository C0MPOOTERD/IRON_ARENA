// ================= GAME MODES =================
const TEAMCOL = { red: '#f87171', blue: '#60a5fa' };
// Each mode unlocks once your total XP reaches its "xp" number. XP is only ever earned, never spent, so a mode stays unlocked.
// Change the "xp" numbers to make modes easier or harder to unlock.
const MODES = [
    { id: 'br', name: 'BATTLE ROYALE', icon: '💥', xp: 0, desc: '25 tanks, last one standing. The red barrier closes in.' },
    { id: 'tdm', name: 'TEAMS', icon: '🛡️', xp: 500, desc: 'Red vs Blue. Respawn at your base. First team to 60 kills wins. No closing barrier.' },
    { id: 'ctf', name: 'CAPTURE THE FLAG', icon: '🚩', xp: 25000, desc: 'Steal the enemy flag and carry it to your base. First team to 3 captures wins. Killed carriers drop the flag. Bonus XP and scrap for captures and for killing carriers.' },
    { id: 'jug', name: 'JUGGERNAUT', icon: '👑', xp: 60000, desc: 'One giant, insanely powerful Juggernaut vs everyone else. Hunters respawn. Every hit on the Juggernaut earns scrap and XP. Kill it to win. The Juggernaut wins at 40 kills.' }
];

function tankById(id) {
    if (!id) return null;
    if (player && player.id === id) return player;
    return tanks.find(t => t.id === id) || mp.graveyard[id] || null;
}

// who a bullet can hurt (no friendly fire in team modes)
function mpTargetsFor(b) {
    let list = b.owner === 'player' ? tanks : [player, ...tanks.filter(t => t.id !== b.sourceId)];
    if (mp.mode !== 'br') {
        if (b.team === undefined) {
            const src = b.owner === 'player' ? player : (b.sourceId === player.id ? player : tanks.find(t => t.id === b.sourceId));
            b.team = src ? src.team : null;
        }
        if (b.team) list = list.filter(t => t.team !== b.team);
    }
    return list;
}

// hitting the Juggernaut pays out scrap + XP in proportion to the damage dealt
function mpJugHit(b) {
    if (mp.mode !== 'jug' || mp.over) return;
    awardScrap(Math.max(1, Math.round(b.damage * 0.4)), 1);
}

// ---------- mode picker ----------
function openModes() {
    const box = $('modes-list'); box.innerHTML = '';
    $('modes-credits').innerText = playerState.infinite ? 'UNLIMITED' : Math.floor(playerState.xp).toLocaleString();
    MODES.forEach(m => {
        const unlocked = playerState.infinite || playerState.xp >= m.xp;
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center gap-3 p-3 bg-slate-900/80 rounded-xl border ' + (unlocked ? 'border-slate-700' : 'border-slate-800 opacity-70');
        row.innerHTML = '<div class="flex items-center gap-3 min-w-0"><span class="text-3xl">' + m.icon + '</span><div class="min-w-0"><div class="font-bold text-slate-100 text-sm">' + m.name +
            '</div><div class="text-[11px] text-slate-400">' + m.desc + '</div>' + (unlocked ? '' : '<div class="text-[11px] text-amber-400 font-bold mt-0.5">Unlocks at ' + m.xp.toLocaleString() + ' XP</div>') + '</div></div>';
        const btn = document.createElement('button');
        btn.className = 'px-4 py-2 font-black text-xs rounded-lg flex-shrink-0 ' + (unlocked ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-slate-950 cursor-pointer' : 'bg-slate-800 text-slate-500');
        btn.textContent = unlocked ? 'PLAY' : 'LOCKED';
        btn.disabled = !unlocked;
        if (unlocked) btn.addEventListener('click', () => { sound.playClick(); mp.selectedMode = m.id; $('screen-modes').classList.add('hidden'); mpQueue(); });
        row.appendChild(btn); box.appendChild(row);
    });
    $('screen-modes').classList.remove('hidden');
    gameState = 'MODES';
}
$('btn-modes-back').addEventListener('click', () => {
    sound.playClick();
    $('screen-modes').classList.add('hidden'); $('screen-menu').classList.remove('hidden');
    gameState = 'MENU';
});

// ---------- scoring / winning (host decides) ----------
function mkFlag(team) { const b = mp.bases[team]; return { team, hx: b.x, hy: b.y, x: b.x, y: b.y, home: true, carrier: null, dropAt: 0 }; }
function resetFlag(f) { f.x = f.hx; f.y = f.hy; f.home = true; f.carrier = null; }

function mpEvent(ev) { mpSend(Object.assign({ t: 'ev' }, ev)); handleEv(ev); }
function handleEv(ev) {
    const who = tankById(ev.by);
    const name = who ? who.name : 'A tank';
    const TN = ev.team ? ev.team.toUpperCase() : '';
    const mine = ev.by && ev.by === mp.myId && player && !mp.over;
    if (ev.k === 'pickup') flashToast('🚩 FLAG TAKEN', name + ' grabbed the ' + TN + ' flag');
    else if (ev.k === 'drop') flashToast('🚩 FLAG DROPPED', 'The ' + TN + ' flag is on the ground');
    else if (ev.k === 'return') flashToast('🚩 FLAG RETURNED', 'The ' + TN + ' flag is back at base');
    else if (ev.k === 'capture') {
        if (mine) { awardScrap(500, 0.5); flashToast('FLAG CAPTURED!', '+500 SCRAP  +250 XP'); }
        else flashToast('🚩 ' + TN + ' CAPTURE!', name + ' scored for ' + TN);
    } else if (ev.k === 'carrierkill') {
        if (mine) { awardScrap(250, 0.5); flashToast('FLAG CARRIER DOWN!', '+250 SCRAP  +125 XP'); }
        else flashToast('FLAG CARRIER KILLED', name + ' stopped the ' + TN + ' carrier');
    }
}

function mpHostKill(victimId, killerId) {
    if (!mp.isHost() || mp.over) return;
    const v = tankById(victimId), k = tankById(killerId);
    const vt = v && v.team, kt = k && k.team;
    if (mp.mode === 'tdm') {
        if (kt && kt !== vt) { mp.score[kt]++; if (mp.score[kt] >= mp.target) mpOverHost(kt); }
    } else if (mp.mode === 'ctf') {
        for (const team of ['red', 'blue']) {
            const f = mp.flags[team];
            if (f.carrier === victimId) { f.carrier = null; f.dropAt = Date.now(); mpEvent({ k: 'carrierkill', by: killerId, team: vt }); mpEvent({ k: 'drop', team }); }
        }
    } else if (mp.mode === 'jug') {
        if (v && v.jug) mpOverHost('blue');
        else if (k && k.jug) { mp.score.jug++; if (mp.score.jug >= mp.target) mpOverHost('red'); }
    }
}

function mpFlagTick() {
    const now = Date.now();
    const alive = tanks.filter(t => t.hp > 0);
    if (!mp.dead && player) alive.push(player);
    const held = new Set(['red', 'blue'].map(t => mp.flags[t].carrier).filter(Boolean));
    for (const team of ['red', 'blue']) {
        const f = mp.flags[team];
        if (f.carrier) {
            const c = alive.find(t => t.id === f.carrier);
            if (!c) { f.carrier = null; f.dropAt = now; mpEvent({ k: 'drop', team }); continue; }
            f.x = c.x; f.y = c.y;
            const base = mp.bases[c.team];
            if (Math.hypot(c.x - base.x, c.y - base.y) < 110) {
                if (c.team !== team) {
                    mp.score[c.team]++; resetFlag(f);
                    mpEvent({ k: 'capture', by: c.id, team: c.team });
                    if (mp.score[c.team] >= mp.target) { mpOverHost(c.team); return; }
                } else { resetFlag(f); mpEvent({ k: 'return', by: c.id, team }); }
            }
        } else {
            if (!f.home && now - f.dropAt > 30000) { resetFlag(f); mpEvent({ k: 'return', by: null, team }); continue; }
            for (const c of alive) {
                if (held.has(c.id)) continue;
                if (Math.hypot(c.x - f.x, c.y - f.y) < 50) {
                    if (f.home && c.team === team) continue;
                    f.carrier = c.id; f.home = false; held.add(c.id);
                    mpEvent({ k: 'pickup', by: c.id, team });
                    break;
                }
            }
        }
    }
}

function mpHostTick() {
    if (!mp.isHost() || mp.over) return;
    if (mp.mode === 'ctf' && mp.flags) mpFlagTick();
    if (mp.mode === 'jug' && !tankById(mp.jugId)) mpOverHost('blue');
}

function mpOverHost(team) {
    if (mp.over) return;
    mpSend({ t: 'over', winner: team });
    mpOver(team);
}
function mpOver(team) {
    if (mp.over || !mp.inMatch || !player) return;
    mp.over = true;
    clearTimeout(mp.respawnTimer);
    $('spectate-bar').classList.add('hidden');
    const mine = player.team === team;
    awardScrap(mine ? 500 : 100, 1);
    flashToast(mine ? 'YOUR TEAM WINS!' : 'YOUR TEAM LOST', mine ? '+500 SCRAP' : '+100 SCRAP');
    if (mine) { mp.dead = false; delayVictoryForTakedown(); }
    else setTimeout(() => { if (mp.inMatch) triggerGameOver(false, true); }, 1500);
}

// ---------- respawning (team modes) ----------
function mpRespawnPos(team) {
    if (mp.mode === 'jug') return mp.ringPoints[Math.floor(Math.random() * mp.ringPoints.length)];
    const b = mp.bases[team];
    return { x: b.x + (Math.random() - 0.5) * 160, y: b.y + (Math.random() - 0.5) * 160 };
}
function enterRespawn() {
    mp.dead = true;
    mpSend({ t: 'dead', killer: mp.lastHitBy, x: Math.round(player.x), y: Math.round(player.y), pu: Math.random() > 0.5 ? 'heal' : 'rapid' });
    if (mp.isHost()) { mp.graveyard[player.id] = player; mpHostKill(player.id, mp.lastHitBy); }
    addExplosion(player.x, player.y, '#ef4444', 30, true);
    sound.playDeathSound();
    player.hp = 0; updateHUD();
    player.x = -5000; player.y = -5000;
    mouse.down = false; mouse.clicked = false;
    $('spectate-bar').classList.remove('hidden');
    if (player.jug) { $('spectate-text').innerText = 'JUGGERNAUT DOWN'; return; }
    mp.respawnAt = Date.now() + 3000;
    mp.respawnTimer = setTimeout(doRespawn, 3000);
}
function doRespawn() {
    if (!mp.inMatch || !mp.dead || mp.over) return;
    const p = mpRespawnPos(player.team);
    player.x = p.x; player.y = p.y; player.hp = player.maxHp; player.flameFuel = 100;
    mp.dead = false; mp.shieldUntil = Date.now() + 2500;
    $('spectate-bar').classList.add('hidden');
    delete mp.graveyard[player.id];
    mpSend({ t: 'respawn', x: Math.round(p.x), y: Math.round(p.y), hp: player.maxHp });
    camera.x = Math.max(0, Math.min(WORLD_WIDTH - canvas.width, player.x - canvas.width / 2));
    camera.y = Math.max(0, Math.min(WORLD_HEIGHT - canvas.height, player.y - canvas.height / 2));
    updateHUD();
}
function mpScheduleBotRespawn(t) {
    const mid = mp.matchId;
    setTimeout(() => mpRespawnBot(t, mid), 3000);
}
function mpRespawnBot(t, mid) {
    if (!mp.inMatch || mp.matchId !== mid || !mp.isHost() || mp.over || !mp.graveyard[t.id]) return;
    delete mp.graveyard[t.id];
    const p = mpRespawnPos(t.team);
    t.x = p.x; t.y = p.y; t.tx = p.x; t.ty = p.y; t.hp = t.maxHp;
    t.shieldUntil = Date.now() + 2500; t.stuck = 0; t.detour = 0; t.lastShot = Date.now() + 800;
    tanks.push(t);
    mpSend({ t: 'respawn', id: t.id, x: Math.round(p.x), y: Math.round(p.y), hp: t.maxHp });
}

// ---------- bot AI for team modes (runs on the host only) ----------
function mpBotFire(b) {
    const weapon = WEAPONS[b.weaponId] || WEAPONS.starter;
    b.lastShot = Date.now();
    if (player && Math.hypot(b.x - player.x, b.y - player.y) < 900) sound.playShoot(weapon.id === 'flamethrower' ? 'flame' : (weapon.id === 'mortar' ? 'mortar' : 'starter'));
    const dx = Math.cos(b.turretAngle), dy = Math.sin(b.turretAngle), px = -dy, py = dx;
    const shotCount = weapon.id === 'twinbarrel' ? 2 : (weapon.id === 'flamethrower' ? 3 : 1);
    const shotDamage = Math.max(6, Math.round(weapon.damage * (b.type === 'boss' ? 0.8 : 0.6)));
    for (let shot = 0; shot < shotCount; shot++) {
        const spread = weapon.id === 'flamethrower' ? (Math.random() - 0.5) * 0.4 : 0;
        const angle = b.turretAngle + spread;
        const off = weapon.id === 'twinbarrel' ? (shot === 0 ? -6 : 6) : 0;
        bullets.push({
            x: b.x + dx * 30 + px * off, y: b.y + dy * 30 + py * off,
            vx: Math.cos(angle) * weapon.speed, vy: Math.sin(angle) * weapon.speed, damage: shotDamage,
            radius: weapon.id === 'flamethrower' ? 8 : (weapon.id === 'mortar' ? 10 : 5),
            type: weapon.id === 'flamethrower' ? 'flame' : weapon.id, bounces: weapon.id === 'ricochet' ? 3 : 0,
            range: weapon.range, distTraveled: 0, color: weapon.color, owner: 'enemy', sourceId: b.id
        });
    }
}

function mpBotThink(b) {
    const now = Date.now();
    let target = null, td = Infinity;
    const consider = t => { if (t.hp > 0 && t.team !== b.team) { const d = Math.hypot(t.x - b.x, t.y - b.y); if (d < td) { td = d; target = t; } } };
    tanks.forEach(consider);
    if (!mp.dead && player) consider(player);

    let gx = null, gy = null, hold = 0;
    const myBase = mp.bases[b.team];
    if (mp.mode === 'ctf' && mp.flags) {
        const enemyTeam = b.team === 'red' ? 'blue' : 'red';
        const ef = mp.flags[enemyTeam], of = mp.flags[b.team];
        if (ef.carrier === b.id || of.carrier === b.id) { gx = myBase.x; gy = myBase.y; }
        else if (b.role === 'attacker') {
            if (ef.carrier) { const c = tankById(ef.carrier); if (c) { gx = c.x; gy = c.y; hold = 150; } }
            else { gx = ef.x; gy = ef.y; }
        } else {
            if (of.carrier) { const c = tankById(of.carrier); if (c) { gx = c.x; gy = c.y; } }
            else if (!of.home) { gx = of.x; gy = of.y; }
            else if (target && td < 550) { gx = target.x; gy = target.y; hold = 260; }
            else { gx = myBase.x; gy = myBase.y; hold = 220; }
        }
    } else if (mp.mode === 'tdm') {
        if (target) { gx = target.x; gy = target.y; hold = b.type === 'rusher' ? 150 : (b.type === 'sniper' ? 420 : 260); }
        else { const eb = mp.bases[b.team === 'red' ? 'blue' : 'red']; gx = eb.x; gy = eb.y; hold = 100; }
    } else if (target) { gx = target.x; gy = target.y; hold = b.type === 'rusher' ? 200 : 450; }

    let vx = 0, vy = 0;
    if (gx !== null) {
        const dg = Math.hypot(gx - b.x, gy - b.y);
        if (dg > hold) {
            let ang = Math.atan2(gy - b.y, gx - b.x);
            if (b.detour > 0) { ang += (b.detourDir || 1) * 1.3; b.detour--; }
            b.angle = ang; vx = Math.cos(ang) * b.speed; vy = Math.sin(ang) * b.speed;
        } else if (target) {
            const ang = Math.atan2(target.y - b.y, target.x - b.x) + (Math.sin(now / 1500 + (parseInt(String(b.id).slice(1)) || 0)) > 0 ? 1 : -1) * Math.PI / 2;
            b.angle = ang; vx = Math.cos(ang) * b.speed * 0.5; vy = Math.sin(ang) * b.speed * 0.5;
        }
    }
    if (vx || vy) {
        const px = b.x, py = b.y;
        moveEntityWithCollisions(b, vx, vy);
        if (Math.hypot(b.x - px, b.y - py) < Math.hypot(vx, vy) * 0.35) {
            b.stuck = (b.stuck || 0) + 1;
            if (b.stuck > 6) { b.detour = 45; b.detourDir = Math.random() < 0.5 ? 1 : -1; b.stuck = 0; }
        } else b.stuck = 0;
    }
    if (target) {
        b.turretAngle = Math.atan2(target.y - b.y, target.x - b.x);
        const w = WEAPONS[b.weaponId] || WEAPONS.starter;
        if (td < w.range * 0.9 && now - b.lastShot > b.shootInterval) mpBotFire(b);
    } else b.turretAngle = b.angle;
}

// ---------- drawing ----------
function drawFlagAt(x, y, team) {
    ctx.save(); ctx.translate(x, y);
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -46); ctx.stroke();
    ctx.fillStyle = TEAMCOL[team];
    ctx.beginPath(); ctx.moveTo(0, -46); ctx.lineTo(30, -37); ctx.lineTo(0, -28); ctx.closePath(); ctx.fill();
    ctx.restore();
}
function mpDrawModeObjects() {
    if (!mp.inMatch || !mp.teamMode || !mp.bases) return;
    if (mp.mode === 'jug') return;
    for (const team of ['red', 'blue']) {
        const b = mp.bases[team];
        ctx.save();
        ctx.globalAlpha = 0.18; ctx.fillStyle = TEAMCOL[team];
        ctx.beginPath(); ctx.arc(b.x, b.y, 110, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.7; ctx.strokeStyle = TEAMCOL[team]; ctx.lineWidth = 3; ctx.setLineDash([12, 8]);
        ctx.beginPath(); ctx.arc(b.x, b.y, 110, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
    }
    if (mp.flags) for (const team of ['red', 'blue']) { const f = mp.flags[team]; if (!f.carrier) drawFlagAt(f.x, f.y, team); }
}
function mpDrawCarriedFlags() {
    if (!mp.inMatch || !mp.flags) return;
    for (const team of ['red', 'blue']) {
        const f = mp.flags[team];
        if (!f.carrier) continue;
        const c = tankById(f.carrier);
        if (c && c.hp > 0 && c.x > -1000) drawFlagAt(c.x, c.y - 6, team);
    }
}

// ---------- mode HUD + respawn countdown ----------
setInterval(() => {
    if (!mp.inMatch || !mp.teamMode) return;
    const s = mp.score || {};
    const flagText = team => {
        const f = mp.flags && mp.flags[team]; if (!f) return '';
        if (f.carrier) { const c = tankById(f.carrier); return 'CARRIED BY ' + (c ? c.name : '?'); }
        return f.home ? 'AT BASE' : 'DROPPED';
    };
    let h = '';
    if (mp.mode === 'tdm') h = '<span style="color:' + TEAMCOL.red + '">RED ' + (s.red || 0) + '</span> &nbsp; FIRST TO ' + mp.target + ' &nbsp; <span style="color:' + TEAMCOL.blue + '">BLUE ' + (s.blue || 0) + '</span>';
    else if (mp.mode === 'ctf') h = '<span style="color:' + TEAMCOL.red + '">RED ' + (s.red || 0) + '</span> &nbsp; CAPTURES TO ' + mp.target + ' &nbsp; <span style="color:' + TEAMCOL.blue + '">BLUE ' + (s.blue || 0) + '</span><div class="text-[10px] text-slate-300 mt-0.5"><span style="color:' + TEAMCOL.red + '">RED FLAG: ' + flagText('red') + '</span> &nbsp; <span style="color:' + TEAMCOL.blue + '">BLUE FLAG: ' + flagText('blue') + '</span></div>';
    else if (mp.mode === 'jug') { const j = tankById(mp.jugId); h = '👑 ' + (j ? j.name : 'JUGGERNAUT') + ' &nbsp; KILLS ' + (s.jug || 0) + '/' + mp.target + (j ? ' &nbsp; HP ' + Math.max(0, Math.ceil(j.hp)) : ''); }
    $('mode-hud-text').innerHTML = h;
    if (mp.dead && mp.respawnAt && !mp.over && player && !player.jug) $('spectate-text').innerText = 'ELIMINATED - RESPAWNING IN ' + Math.max(0, Math.ceil((mp.respawnAt - Date.now()) / 1000));
}, 200);
