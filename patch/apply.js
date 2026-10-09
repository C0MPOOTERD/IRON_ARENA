// Turns your single-player Iron Arena HTML into the online version.
// Usage: put your game file at iron-arena/original.html, then run:  npm run patch
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const input = process.argv[2] || path.join(root, 'original.html');
const output = path.join(root, 'public', 'index.html');
let src;
try { src = fs.readFileSync(input, 'utf8').replace(/\r\n/g, '\n'); }
catch (e) { console.error('Could not read ' + input + '\nSave your game file there (or pass its path as an argument).'); process.exit(1); }
if (src.includes('ONLINE MULTIPLAYER + ACCOUNTS')) { console.error('That file is already patched. Use the original single-player file.'); process.exit(1); }
const rd = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const fail = msg => { console.error('PATCH FAILED: ' + msg + '\nThis patch expects the original Iron Arena file.'); process.exit(1); };
function rep(oldStr, newStr) {
    const n = src.split(oldStr).length - 1;
    if (n !== 1) fail('anchor found ' + n + ' times (need exactly 1): ' + oldStr.slice(0, 90));
    src = src.replace(oldStr, () => newStr);
}
function region(startStr, endStr, newStr) {
    const a = src.indexOf(startStr), b = src.indexOf(endStr);
    if (a < 0 || b < a) fail('region not found: ' + startStr);
    src = src.slice(0, a) + newStr + src.slice(b);
}

// ---- HTML ----
const menuRe = /(FIELD MANUAL\s*<\/button>\s*<\/div>)/;
if (!menuRe.test(src)) fail('menu buttons not found');
src = src.replace(menuRe, (m) => m + '\n' + rd('auth-box.html'));
rep('<!-- Instructions Modal -->', rd('overlays.html').trimEnd());

// ---- arena generation (seeded, 12 slots, humans + bots) ----
region('function chooseBotWeaponId()', 'function addExplosion(', rd('arena.js'));

// ---- barrels (synced by id) ----
region('function breakBarrel(index) {', 'function addMuzzleFlash', `function breakBarrel(index, net) {
            const barrel = barrels[index];
            if (!barrel) return;
            const pu = (net && net.pu) || (Math.random() > 0.5 ? 'heal' : 'rapid');
            addExplosion(barrel.x, barrel.y, '#f59e0b', 18, true);
            powerups.push({ x: barrel.x, y: barrel.y, type: pu });
            barrels.splice(index, 1);
            if (!net) mpSend({ t: 'barrel', id: barrel.id, pu });
        }

        `);
rep('if (bar.hp <= 0) breakBarrel(j);', 'if (bar.hp <= 0 && (!mp.inMatch || mp.isHost())) breakBarrel(j);');

// ---- drawing: usernames above tanks (team colors + rings), flags/bases, hide dead player ----
rep('if (t !== player && t.maxHp) {', `if (t.name) {
                context.save();
                if (t.team) {
                    context.globalAlpha = 0.6; context.strokeStyle = TEAMCOL[t.team]; context.lineWidth = 3;
                    context.beginPath(); context.arc(t.x, t.y, t.radius + 5, 0, Math.PI * 2); context.stroke();
                    context.globalAlpha = 1;
                }
                context.font = 'bold 11px Orbitron'; context.textAlign = 'center'; context.textBaseline = 'bottom';
                context.lineWidth = 3; context.strokeStyle = 'rgba(2, 6, 23, 0.9)';
                context.fillStyle = t.team ? TEAMCOL[t.team] : (t.name === 'BOT' ? '#fca5a5' : (t === player ? '#67e8f9' : '#fde68a'));
                const label = (t.jug ? '\\uD83D\\uDC51 ' : '') + t.name;
                context.strokeText(label, t.x, t.y - t.radius - 22);
                context.fillText(label, t.x, t.y - t.radius - 22);
                context.restore();
            }
            if (t !== player && t.maxHp) {`);
rep('if (player) drawTank(player, ctx);', 'if (player && !mp.dead) drawTank(player, ctx);\n            mpDrawCarriedFlags();');
rep('bullets.forEach(b => { ctx.fillStyle = b.color;', 'mpDrawModeObjects();\n            bullets.forEach(b => { ctx.fillStyle = b.color;');

// ---- bigger arena (room for 25 tanks) ----
rep('const WORLD_WIDTH = 3000;', 'const WORLD_WIDTH = 4000;');
rep('const WORLD_HEIGHT = 2200;', 'const WORLD_HEIGHT = 3000;');
// red barrier only closes in during Battle Royale
rep('if (arenaBoundary.w > 600 && arenaBoundary.h > 600) {', "if (mp.mode === 'br' && arenaBoundary.w > 600 && arenaBoundary.h > 600) {");
// juggernaut speed bonus
rep('const currentSpeed = playerState.speed * (moveX', 'const currentSpeed = playerState.speed * (player.speedMult || 1) * (moveX');
// no friendly fire in team modes
rep("const targets = b.owner === 'player' ? tanks : [player, ...tanks.filter(tank => tank.id !== b.sourceId)];", 'const targets = mpTargetsFor(b);');

// ---- update loop hooks ----
rep('if (playerState.rapidFireTimer > 0) playerState.rapidFireTimer -= 16;', 'if (Date.now() < mp.freezeUntil) { mouse.clicked = false; return; }\n            if (playerState.rapidFireTimer > 0) playerState.rapidFireTimer -= 16;');
// fix stray lines on patterned skins: outline the hull itself, not the last pattern shape
rep("context.lineWidth = 2; context.strokeStyle = '#0f172a'; context.stroke();", "context.beginPath(); context.roundRect(hullLeft, hullTop, hullSize, hullSize, 6);\n            context.lineWidth = 2; context.strokeStyle = '#0f172a'; context.stroke();");
rep('awardScrap(3);', 'if (!mp.dead) awardScrap(3);');
rep('for (const entity of [player, ...tanks]) {', 'for (const entity of (mp.dead ? tanks : [player, ...tanks])) {');
rep('if (player.x < arenaBoundary.x || player.x > arenaBoundary.x + arenaBoundary.w || player.y < arenaBoundary.y || player.y > arenaBoundary.y + arenaBoundary.h) {',
    'if (!mp.dead && (player.x < arenaBoundary.x || player.x > arenaBoundary.x + arenaBoundary.w || player.y < arenaBoundary.y || player.y > arenaBoundary.y + arenaBoundary.h)) {');
rep('if (moveX !== 0 || moveY !== 0) {', 'if (!mp.dead && (moveX !== 0 || moveY !== 0)) {');
rep('player.flameShotThisFrame = false;', 'const mpStartLen = bullets.length;\n            player.flameShotThisFrame = false;');
rep('if (mouse.clicked) {', 'if (mp.dead) { mouse.clicked = false; } else if (mouse.clicked) {');
rep('updateEnemies();', 'updateEnemies();\n            mpTick(mpStartLen);');
rep('player.x - canvas.width / 2', 'followTarget().x - canvas.width / 2');
rep('player.y - canvas.height / 2', 'followTarget().y - canvas.height / 2');

// ---- bots run on the host only; remote tanks are mirrored ----
rep('function updateEnemies() {', `function updateEnemies() {
            if (mp.inMatch && !mp.isHost()) { mpSmooth(false); return; }
            if (mp.inMatch) mpSmooth(true);`);
rep('let target = player;', `if (enemy.isHuman) return;
                if (mp.mode !== 'br') { mpBotThink(enemy); return; }
                let target = (player.hp > 0 && !mp.dead) ? player : null;
                if (!target) target = tanks.find(o => o !== enemy) || null;
                if (!target) return;`);
rep('if (enemy.hp > 0) continue;', 'if (enemy.isHuman || enemy.hp > 0) continue;');
rep('tanks.splice(i, 1);', 'mpSendKill(enemy, null);\n                tanks.splice(i, 1);');
rep('if (tanks.length === 0) triggerGameOver(true);', 'if (tanks.length === 0 && !mp.inMatch) triggerGameOver(true);');

// ---- bullet damage: each client damages only its own tank; the host damages bots ----
rep('target.hp -= b.damage;', `if (target === player) mp.lastHitBy = b.sourceId || null;
                        const shielded = (target === player && Date.now() < mp.shieldUntil) || (target.shieldUntil > Date.now());
                        if (!shielded && (!mp.inMatch || target === player || (mp.isHost() && !target.isHuman))) target.hp -= b.damage;
                        if (b.owner === 'player' && target.jug && !shielded) mpJugHit(b);`);
rep('} else if (target.hp <= 0) {', '} else if (target.hp <= 0 && !target.isHuman && (!mp.inMatch || mp.isHost())) {');
rep('tanks.splice(tanks.indexOf(target), 1);', 'mpSendKill(target, b.sourceId || (b.owner === \'player\' ? mp.myId : null));\n                            tanks.splice(tanks.indexOf(target), 1);');
rep('if (tanks.length === 0) {', 'if (tanks.length === 0 && !mp.inMatch) {');

// ---- HUD safety before first match ----
rep('function updateHUD() {', `function updateHUD() {
            if (!player) {
                document.getElementById('garage-credits').innerText = playerState.credits;
                document.getElementById('shop-credits').innerText = playerState.credits;
                return;
            }`);

// ---- deploy button now goes through matchmaking ----
rep("generateArena(playerState.arena); gameState = 'PLAYING'; updateHUD();", 'mpQueue();');

// ---- multiplayer + accounts runtime ----
rep('function gameLoop() {', rd('mp-client.js') + '\n' + rd('modes.js') + '\n        function gameLoop() {');

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, src);
console.log('Done. Wrote ' + output + '\nNext: npm install && npm start');
