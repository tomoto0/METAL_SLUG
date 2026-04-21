import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { Projectile } from './Projectile.js';

/**
 * 敵戦車
 * subType: 'light' | 'heavy'
 * 茶色/ダークグレー系、プレイヤー戦車より大きい
 */
export class EnemyTank extends Enemy {
    constructor(scene, {
        position,
        subType = 'light',
    }) {
        // Metal Slug 戦車スコア: Di-Cokka 相当の light=1500, heavy/Hairbuster 相当=3000
        // HP: キャノン 3〜4 発、もしくはバルカン連射で処理できる目安
        const SPECS = {
            light: { hp: 70,  speed: 2.0, scoreValue: 1500, fireRate: 2.0, damage: 15 },
            heavy: { hp: 140, speed: 1.0, scoreValue: 3000, fireRate: 1.5, damage: 20 },
        };
        const spec = SPECS[subType] || SPECS.light;

        super(scene, { position, ...spec, type: 'tank' });
        this.subType = subType;

        // AI
        this.aiState = 'advance';
        this.attackRange = subType === 'heavy' ? 30 : 22;
        this.movePauseTimer = 0;
        this.movePhase = 'move'; // 'move' | 'pause'

        // 射程を通る導線（スポーン後最初の update で決定）
        this.crossTargetX = null;
        this.crossTargetZ = null;

        this._buildModel();
        this._recordMaterials();
        this.scene.add(this.group);
    }

    _buildModel() {
        const isHeavy = this.subType === 'heavy';
        const scale = isHeavy ? 1.35 : 1.0;

        const C = {
            hull: 0x788060,
            hullHi: 0xAAB088,
            hullDark: 0x4A5038,
            turret: 0x667050,
            metal: 0x606058,
            track: 0x282820,
            trackInner: 0x404038,
            rust: 0x905828,
            accent: isHeavy ? 0xBB3020 : 0x9A7838,
            light: 0xFFD860,
        };

        this.wheels = [];

        for (let side = -1; side <= 1; side += 2) {
            const pod = new THREE.Group();

            const trackOuter = new THREE.Mesh(
                new THREE.BoxGeometry(3.4 * scale, 1.02 * scale, 0.62 * scale),
                new THREE.MeshStandardMaterial({ color: C.track, roughness: 0.9, metalness: 0.2 })
            );
            trackOuter.position.y = 0.52 * scale;
            trackOuter.castShadow = true;
            pod.add(trackOuter);

            const trackInner = new THREE.Mesh(
                new THREE.BoxGeometry(3.0 * scale, 0.72 * scale, 0.44 * scale),
                new THREE.MeshStandardMaterial({ color: C.trackInner, roughness: 0.82, metalness: 0.18 })
            );
            trackInner.position.y = 0.52 * scale;
            pod.add(trackInner);

            const wheelMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.35, metalness: 0.55 });
            const mainWheelGeo = new THREE.CylinderGeometry(0.38 * scale, 0.38 * scale, 0.18 * scale, 12);
            const roadWheelGeo = new THREE.CylinderGeometry(0.24 * scale, 0.24 * scale, 0.15 * scale, 10);

            for (const x of [-1.22, 1.22]) {
                const wheel = new THREE.Mesh(mainWheelGeo, wheelMat);
                wheel.rotation.x = Math.PI / 2;
                wheel.position.set(x * scale, 0.5 * scale, 0);
                pod.add(wheel);
                this.wheels.push(wheel);
            }

            for (const x of [-0.55, 0, 0.55]) {
                const wheel = new THREE.Mesh(roadWheelGeo, wheelMat);
                wheel.rotation.x = Math.PI / 2;
                wheel.position.set(x * scale, 0.42 * scale, 0);
                pod.add(wheel);
                this.wheels.push(wheel);
            }

            const fender = new THREE.Mesh(
                new THREE.BoxGeometry(3.15 * scale, 0.08 * scale, 0.72 * scale),
                new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.72, metalness: 0.18 })
            );
            fender.position.y = 1.04 * scale;
            pod.add(fender);

            const skirt = new THREE.Mesh(
                new THREE.BoxGeometry(2.8 * scale, 0.34 * scale, 0.08 * scale),
                new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.62, metalness: 0.18 })
            );
            skirt.position.set(0, 0.92 * scale, side * 0.28 * scale);
            pod.add(skirt);

            pod.position.set(0, 0, side * 1.22 * scale);
            this.group.add(pod);
        }

        const belly = new THREE.Mesh(
            new THREE.SphereGeometry(1.38 * scale, 18, 14, 0, Math.PI * 2, Math.PI * 0.2, Math.PI * 0.48),
            new THREE.MeshStandardMaterial({ color: C.hull, roughness: 0.58, metalness: 0.16 })
        );
        belly.scale.set(1.15, 0.72, 0.84);
        belly.position.set(-0.05 * scale, 1.22 * scale, 0);
        belly.castShadow = true;
        this.group.add(belly);

        const upperHull = new THREE.Mesh(
            new THREE.BoxGeometry(2.95 * scale, 0.84 * scale, 2.15 * scale),
            new THREE.MeshStandardMaterial({ color: C.hull, roughness: 0.66, metalness: 0.2 })
        );
        upperHull.position.set(0, 1.62 * scale, 0);
        upperHull.castShadow = true;
        this.group.add(upperHull);

        const frontGlacis = new THREE.Mesh(
            new THREE.BoxGeometry(0.95 * scale, 0.78 * scale, 1.95 * scale),
            new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.52, metalness: 0.24 })
        );
        frontGlacis.position.set(1.48 * scale, 1.5 * scale, 0);
        frontGlacis.rotation.z = -0.24;
        this.group.add(frontGlacis);

        const hullHighlight = new THREE.Mesh(
            new THREE.BoxGeometry(1.95 * scale, 0.14 * scale, 1.7 * scale),
            new THREE.MeshStandardMaterial({ color: C.hullHi, roughness: 0.32, metalness: 0.12 })
        );
        hullHighlight.position.set(-0.08 * scale, 1.95 * scale, 0);
        this.group.add(hullHighlight);

        const rearDeck = new THREE.Mesh(
            new THREE.BoxGeometry(1.05 * scale, 0.18 * scale, 1.58 * scale),
            new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.45, metalness: 0.35 })
        );
        rearDeck.position.set(-1.1 * scale, 1.98 * scale, 0);
        this.group.add(rearDeck);

        for (const z of [-0.58, 0.58]) {
            const exhaust = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08 * scale, 0.11 * scale, 0.56 * scale, 8),
                new THREE.MeshStandardMaterial({ color: C.rust, roughness: 0.78, metalness: 0.18 })
            );
            exhaust.position.set(-1.38 * scale, 1.72 * scale, z * scale);
            exhaust.rotation.z = Math.PI / 2 + 0.28;
            this.group.add(exhaust);
        }

        for (let x = -0.95; x <= 1.15; x += 0.35) {
            for (const z of [-0.88, 0.88]) {
                const rivet = new THREE.Mesh(
                    new THREE.SphereGeometry(0.04 * scale, 5, 4),
                    new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.6 })
                );
                rivet.position.set(x * scale, 1.7 * scale, z * scale);
                this.group.add(rivet);
            }
        }

        for (const z of [-0.52, 0.52]) {
            const headlight = new THREE.Mesh(
                new THREE.SphereGeometry(0.1 * scale, 8, 6),
                new THREE.MeshStandardMaterial({
                    color: C.light,
                    emissive: C.light,
                    emissiveIntensity: 0.4,
                    roughness: 0.35,
                })
            );
            headlight.position.set(1.52 * scale, 1.34 * scale, z * scale);
            this.group.add(headlight);
        }

        this.turretGroup = new THREE.Group();
        this.turretGroup.position.set(0.14 * scale, 2.04 * scale, 0);

        const turretBase = new THREE.Mesh(
            new THREE.CylinderGeometry(0.9 * scale, 1.02 * scale, 0.28 * scale, 14),
            new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.58, metalness: 0.3 })
        );
        this.turretGroup.add(turretBase);

        const turretDome = new THREE.Mesh(
            new THREE.SphereGeometry(1.02 * scale, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.6),
            new THREE.MeshStandardMaterial({ color: C.turret, roughness: 0.5, metalness: 0.24 })
        );
        turretDome.scale.set(1.12, 0.72, 0.96);
        turretDome.position.y = 0.08 * scale;
        turretDome.castShadow = true;
        this.turretGroup.add(turretDome);

        const turretGlow = new THREE.Mesh(
            new THREE.BoxGeometry(1.2 * scale, 0.12 * scale, 0.98 * scale),
            new THREE.MeshStandardMaterial({ color: C.hullHi, roughness: 0.28, metalness: 0.12 })
        );
        turretGlow.position.set(0.08 * scale, 0.48 * scale, 0);
        this.turretGroup.add(turretGlow);

        const cupola = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18 * scale, 0.22 * scale, 0.16 * scale, 10),
            new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.36, metalness: 0.42 })
        );
        cupola.position.set(-0.24 * scale, 0.56 * scale, 0);
        this.turretGroup.add(cupola);

        const barrelLen = isHeavy ? 3.6 : 2.75;
        const barrelRadius = isHeavy ? 0.15 : 0.11;
        const barrelMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.28, metalness: 0.66 });

        const recoilHousing = new THREE.Mesh(
            new THREE.CylinderGeometry((barrelRadius + 0.08) * scale, (barrelRadius + 0.08) * scale, 0.68 * scale, 10),
            barrelMat
        );
        recoilHousing.rotation.z = Math.PI / 2;
        recoilHousing.position.set(0.6 * scale, 0.18 * scale, 0);
        this.turretGroup.add(recoilHousing);

        this.barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelRadius * scale, (barrelRadius + 0.02) * scale, barrelLen * scale, 10),
            barrelMat
        );
        this.barrel.rotation.z = Math.PI / 2;
        this.barrel.position.set((barrelLen / 2 + 0.9) * scale, 0.18 * scale, 0);
        this.barrel.castShadow = true;
        this.turretGroup.add(this.barrel);

        const muzzle = new THREE.Mesh(
            new THREE.CylinderGeometry((barrelRadius + 0.06) * scale, (barrelRadius + 0.02) * scale, 0.28 * scale, 10),
            barrelMat
        );
        muzzle.rotation.z = Math.PI / 2;
        muzzle.position.set((barrelLen + 0.85) * scale, 0.18 * scale, 0);
        this.turretGroup.add(muzzle);

        for (const x of [0.95, 1.45, 1.95]) {
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry((barrelRadius + 0.02) * scale, 0.02 * scale, 6, 10),
                new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.35, metalness: 0.5 })
            );
            ring.rotation.y = Math.PI / 2;
            ring.position.set(x * scale, 0.18 * scale, 0);
            this.turretGroup.add(ring);
        }

        if (isHeavy) {
            const sidePod = new THREE.Mesh(
                new THREE.BoxGeometry(0.82 * scale, 0.34 * scale, 1.55 * scale),
                new THREE.MeshStandardMaterial({ color: C.hullDark, roughness: 0.58, metalness: 0.22 })
            );
            sidePod.position.set(-0.22 * scale, 0.18 * scale, 0);
            this.turretGroup.add(sidePod);

            const coax = new THREE.Mesh(
                new THREE.CylinderGeometry(0.04 * scale, 0.04 * scale, 0.9 * scale, 6),
                barrelMat
            );
            coax.rotation.z = Math.PI / 2;
            coax.position.set(1.12 * scale, 0.42 * scale, 0.42 * scale);
            this.turretGroup.add(coax);
        }

        const accent = new THREE.Mesh(
            new THREE.BoxGeometry(0.08 * scale, 0.22 * scale, 0.92 * scale),
            new THREE.MeshStandardMaterial({ color: C.accent, roughness: 0.52, metalness: 0.1 })
        );
        accent.position.set(0.42 * scale, 0.22 * scale, 0);
        this.turretGroup.add(accent);

        this.group.add(this.turretGroup);
    }

    update(dt, playerPos, elapsedTime) {
        if (!this.alive) return;
        super.update(dt, playerPos, elapsedTime);

        const toPlayer = new THREE.Vector3().subVectors(playerPos, this.group.position);
        toPlayer.y = 0;
        const dist = toPlayer.length();
        const dirToPlayer = toPlayer.clone().normalize();

        // 初回: 導線ターゲットを設定 — 射程内を横切る位置を目標にする
        if (this.crossTargetX === null) {
            const side = this.group.position.x - playerPos.x;
            const crossSide = (side === 0 ? (Math.random() < 0.5 ? 1 : -1) : -Math.sign(side));
            this.crossTargetX = playerPos.x + crossSide * (5 + Math.random() * 4);
            const spawnAhead = this.group.position.z > playerPos.z;
            this.crossTargetZ = playerPos.z + (spawnAhead ? -4 : 10) + (Math.random() - 0.5) * 3;
        }

        const toCross = new THREE.Vector3(
            this.crossTargetX - this.group.position.x,
            0,
            this.crossTargetZ - this.group.position.z
        );
        const crossDist = toCross.length();
        const dirToCross = crossDist > 0.001 ? toCross.clone().normalize() : dirToPlayer.clone();

        // 砲塔をプレイヤー方向に向ける（車体回転を差し引いたローカル回転）
        const turretWorldAngle = Math.atan2(-dirToPlayer.z, dirToPlayer.x);
        this.turretGroup.rotation.y = turretWorldAngle - this.group.rotation.y;

        // 導線ターゲットに接近したら新しい横断点を引き直す
        if (crossDist < 3.0) {
            const side = this.group.position.x - playerPos.x;
            const crossSide = (side === 0 ? (Math.random() < 0.5 ? 1 : -1) : -Math.sign(side));
            this.crossTargetX = playerPos.x + crossSide * (6 + Math.random() * 4);
            this.crossTargetZ = playerPos.z + (Math.random() < 0.5 ? -5 : 10);
        }

        // --- 移動 & 射撃 AI ---
        if (this.subType === 'light') {
            this._aiLight(dt, dist, dirToCross, playerPos, elapsedTime);
        } else {
            this._aiHeavy(dt, dist, dirToCross, playerPos, elapsedTime);
        }

        // 転輪回転
        if (this.aiState === 'advance') {
            this.wheels.forEach(w => { w.rotation.y += dt * 5; });
        }
    }

    _aiLight(dt, dist, dirCross, playerPos, elapsed) {
        // 導線上を前進しながら停止→射撃→前進のリズム
        this.movePauseTimer += dt;
        const bodyAngle = Math.atan2(-dirCross.z, dirCross.x);
        this.group.rotation.y = bodyAngle;

        if (this.movePhase === 'move') {
            this.aiState = 'advance';
            this.group.position.add(dirCross.clone().multiplyScalar(this.speed * dt));
            if (dist < this.attackRange && this.movePauseTimer > 2.5) {
                this.movePhase = 'pause';
                this.movePauseTimer = 0;
            }
        } else {
            this.aiState = 'attack';
            // 停止中も少しだけ前進（完全停止しない）
            this.group.position.add(dirCross.clone().multiplyScalar(this.speed * 0.2 * dt));
            this._fireCannon(playerPos, elapsed);
            if (this.movePauseTimer > 1.5) {
                this.movePhase = 'move';
                this.movePauseTimer = 0;
            }
        }
    }

    _aiHeavy(dt, dist, dirCross, playerPos, elapsed) {
        // 常にゆっくり前進（導線に沿って射程を横断）しながら撃つ
        this.aiState = 'advance';
        this.group.position.add(dirCross.clone().multiplyScalar(this.speed * dt));
        const bodyAngle = Math.atan2(-dirCross.z, dirCross.x);
        this.group.rotation.y = bodyAngle;

        if (dist < this.attackRange) {
            this._fireCannon(playerPos, elapsed);
            if (this.subType === 'heavy') {
                this._fireSpread(playerPos, elapsed);
            }
        }
    }

    _fireCannon(playerPos, elapsed) {
        if (elapsed - this.lastFireTime < this.fireRate) return;
        this.lastFireTime = elapsed;

        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 2.0 * (this.subType === 'heavy' ? 1.4 : 1.0);

        const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        dir.y = 0;
        dir.normalize();

        const shell = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 18,
            damage: this.damage,
            owner: 'enemy',
            type: 'cannon',
            maxDistance: 50,
        });
        this.projectiles.push(shell);
    }

    _fireSpread(playerPos, elapsed) {
        // 3way散弾（メイン砲弾と同時に小弾）
        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 2.8;

        const baseDir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        baseDir.y = 0;
        baseDir.normalize();

        for (let angle of [-0.2, 0.2]) {
            const dir = baseDir.clone();
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const nx = dir.x * cos - dir.z * sin;
            const nz = dir.x * sin + dir.z * cos;
            dir.x = nx;
            dir.z = nz;

            const bullet = new Projectile(this.scene, {
                position: muzzlePos.clone(),
                direction: dir,
                speed: 14,
                damage: 8,
                owner: 'enemy',
                type: 'bullet',
                maxDistance: 40,
            });
            this.projectiles.push(bullet);
        }
    }
}
