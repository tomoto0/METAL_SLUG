import * as THREE from 'three';

const POW_STATES = {
    TIED: 'tied',
    RELEASED: 'released',
    LEAVING: 'leaving',
    DEAD: 'dead',
};

export class POW {
    constructor(scene, position) {
        this.scene = scene;
        this.state = POW_STATES.TIED;
        this.alive = true;
        this.hp = 5;
        this.age = 0;
        this.stateTime = 0;
        this.reward = this._rollReward();
        this.runSpeed = 6.0;
        this.walkPhase = 0;
        this.pendingReward = null;

        this.group = new THREE.Group();
        this._buildModel();
        this.group.position.copy(position);
        this.scene.add(this.group);
    }

    _rollReward() {
        const roll = Math.random();
        if (roll < 0.40) return 'weapon_H';
        if (roll < 0.65) return 'weapon_R';
        if (roll < 0.85) return 'grenade';
        return 'score_big';
    }

    _buildModel() {
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x9B7A4A, roughness: 0.85 });
        const headMat = new THREE.MeshStandardMaterial({ color: 0xE8C28F, roughness: 0.7 });
        const bandMat = new THREE.MeshStandardMaterial({ color: 0xCC2222, roughness: 0.7 });
        const ropeMat = new THREE.MeshStandardMaterial({ color: 0x6B4F2C, roughness: 0.9 });

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.35), bodyMat);
        torso.position.y = 1.1;
        this.group.add(torso);

        const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), headMat);
        head.position.y = 1.75;
        head.scale.set(1.0, 1.1, 1.0);
        this.group.add(head);

        const band = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.06, 6, 12), bandMat);
        band.position.y = 1.88;
        band.rotation.x = Math.PI / 2;
        this.group.add(band);

        this.armL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.14), bodyMat);
        this.armL.position.set(-0.22, 1.0, 0.15);
        this.group.add(this.armL);
        this.armR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.14), bodyMat);
        this.armR.position.set(0.22, 1.0, 0.15);
        this.group.add(this.armR);

        this.ropes = new THREE.Group();
        for (const y of [0.9, 1.1, 1.3]) {
            const r = new THREE.Mesh(
                new THREE.TorusGeometry(0.28, 0.025, 4, 10),
                ropeMat
            );
            r.position.y = y;
            r.rotation.x = Math.PI / 2;
            this.ropes.add(r);
        }
        this.group.add(this.ropes);

        this.legL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.18), bodyMat);
        this.legL.position.set(-0.12, 0.5, 0);
        this.group.add(this.legL);
        this.legR = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.18), bodyMat);
        this.legR.position.set(0.12, 0.5, 0);
        this.group.add(this.legR);

        this.exclaim = this._makeExclaim();
        this.exclaim.position.y = 2.4;
        this.group.add(this.exclaim);
    }

    _makeExclaim() {
        const g = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({ color: 0xFFEE33 });
        const stem = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.08), mat);
        stem.position.y = 0.15;
        const dot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), mat);
        dot.position.y = -0.05;
        g.add(stem);
        g.add(dot);
        return g;
    }

    release() {
        if (this.state !== POW_STATES.TIED) return;
        this.state = POW_STATES.RELEASED;
        this.stateTime = 0;
        this.group.remove(this.ropes);
        this.ropes = null;
        this.armL.rotation.z = 0.2;
        this.armR.rotation.z = -0.2;
        if (this.exclaim) {
            this.group.remove(this.exclaim);
            this.exclaim = null;
        }
    }

    update(dt, playerPos) {
        if (!this.alive) return;
        this.age += dt;
        this.stateTime += dt;

        if (this.state === POW_STATES.TIED) {
            if (this.exclaim) this.exclaim.visible = Math.floor(this.age * 4) % 2 === 0;
            return;
        }

        if (this.state === POW_STATES.RELEASED) {
            this.armL.rotation.z = Math.sin(this.stateTime * 10) * 0.4 + 1.2;
            this.armR.rotation.z = -Math.sin(this.stateTime * 10) * 0.4 - 1.2;
            if (this.stateTime > 1.2) {
                this.state = POW_STATES.LEAVING;
                this.stateTime = 0;
                this._dropReward();
            }
            return;
        }

        if (this.state === POW_STATES.LEAVING) {
            const dx = this.group.position.x - playerPos.x;
            const dz = this.group.position.z - playerPos.z;
            const len = Math.hypot(dx, dz) || 1;
            this.group.position.x += (dx / len) * this.runSpeed * dt;
            this.group.position.z += (dz / len) * this.runSpeed * dt;
            this.group.rotation.y = Math.atan2(dx, dz);
            this.walkPhase += dt * 15;
            this.legL.rotation.x = Math.sin(this.walkPhase) * 0.6;
            this.legR.rotation.x = -Math.sin(this.walkPhase) * 0.6;
            if (this.stateTime > 4.0) {
                this.alive = false;
            }
        }
    }

    _dropReward() {
        this.pendingReward = this.reward;
    }

    takeDamage(amount) {
        if (!this.alive || this.state === POW_STATES.LEAVING) return;
        this.hp -= amount;
        if (this.hp <= 0) {
            this.alive = false;
            this.state = POW_STATES.DEAD;
        }
    }

    destroy() {
        this.alive = false;
        this.scene.remove(this.group);
        this.group.traverse(c => {
            if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
        });
    }
}
