"use client";

import { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float } from "@react-three/drei";
import * as THREE from "three";

interface CarModelProps {
  velocity: number;
  turn: number;
  eStop: boolean;
}

function Wheel({ position, rotation }: { position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <mesh position={position} rotation={rotation || [0, 0, Math.PI / 2]}>
      <cylinderGeometry args={[0.15, 0.15, 0.1, 16]} />
      <meshStandardMaterial color="#1a1a2e" />
      {/* Rim */}
      <mesh>
        <cylinderGeometry args={[0.1, 0.1, 0.11, 8]} />
        <meshStandardMaterial color="#444" metalness={0.8} roughness={0.2} />
      </mesh>
    </mesh>
  );
}

function CarBody({ velocity, turn, eStop }: CarModelProps) {
  const groupRef = useRef<THREE.Group>(null);
  const wheelFLRef = useRef<THREE.Group>(null);
  const wheelFRRef = useRef<THREE.Group>(null);
  const glowRef = useRef<THREE.PointLight>(null);

  // Smooth tilt based on velocity and turn
  useFrame((_, delta) => {
    if (!groupRef.current) return;

    // Tilt forward/back based on velocity
    const targetRotX = -(velocity / 100) * 0.15;
    // Tilt left/right based on turn
    const targetRotZ = -(turn / 100) * 0.2;
    // Yaw based on turn
    const targetRotY = (turn / 100) * 0.3;

    groupRef.current.rotation.x += (targetRotX - groupRef.current.rotation.x) * delta * 4;
    groupRef.current.rotation.z += (targetRotZ - groupRef.current.rotation.z) * delta * 4;
    groupRef.current.rotation.y += (targetRotY - groupRef.current.rotation.y) * delta * 4;

    // Wheel steering
    const steerAngle = (turn / 100) * 0.4;
    if (wheelFLRef.current) {
      wheelFLRef.current.rotation.y += (steerAngle - wheelFLRef.current.rotation.y) * delta * 6;
    }
    if (wheelFRRef.current) {
      wheelFRRef.current.rotation.y += (steerAngle - wheelFRRef.current.rotation.y) * delta * 6;
    }

    // Pulsing glow for e-stop
    if (glowRef.current) {
      if (eStop) {
        glowRef.current.intensity = 2 + Math.sin(Date.now() * 0.01) * 1.5;
        glowRef.current.color.set("#ff0000");
      } else if (Math.abs(velocity) > 5) {
        glowRef.current.intensity = 1;
        glowRef.current.color.set("#00d4ff");
      } else {
        glowRef.current.intensity = 0.5;
        glowRef.current.color.set("#7b2ff7");
      }
    }
  });

  const bodyColor = eStop ? "#ff2244" : "#7b2ff7";

  return (
    <group ref={groupRef}>
      {/* Main body */}
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[0.8, 0.18, 1.4]} />
        <meshStandardMaterial color={bodyColor} metalness={0.6} roughness={0.3} />
      </mesh>

      {/* Cabin */}
      <mesh position={[0, 0.38, -0.1]}>
        <boxGeometry args={[0.6, 0.2, 0.7]} />
        <meshStandardMaterial color="#111" metalness={0.8} roughness={0.2} transparent opacity={0.7} />
      </mesh>

      {/* Front bumper */}
      <mesh position={[0, 0.15, 0.72]}>
        <boxGeometry args={[0.7, 0.12, 0.08]} />
        <meshStandardMaterial color="#222" metalness={0.5} roughness={0.4} />
      </mesh>

      {/* Rear bumper */}
      <mesh position={[0, 0.15, -0.72]}>
        <boxGeometry args={[0.7, 0.12, 0.08]} />
        <meshStandardMaterial color="#222" metalness={0.5} roughness={0.4} />
      </mesh>

      {/* Headlights */}
      <mesh position={[-0.25, 0.22, 0.71]}>
        <sphereGeometry args={[0.06, 8, 8]} />
        <meshStandardMaterial color="#fff" emissive="#00d4ff" emissiveIntensity={1.5} />
      </mesh>
      <mesh position={[0.25, 0.22, 0.71]}>
        <sphereGeometry args={[0.06, 8, 8]} />
        <meshStandardMaterial color="#fff" emissive="#00d4ff" emissiveIntensity={1.5} />
      </mesh>

      {/* Tail lights */}
      <mesh position={[-0.25, 0.22, -0.71]}>
        <sphereGeometry args={[0.05, 8, 8]} />
        <meshStandardMaterial color="#ff0000" emissive="#ff0000" emissiveIntensity={eStop ? 3 : 0.5} />
      </mesh>
      <mesh position={[0.25, 0.22, -0.71]}>
        <sphereGeometry args={[0.05, 8, 8]} />
        <meshStandardMaterial color="#ff0000" emissive="#ff0000" emissiveIntensity={eStop ? 3 : 0.5} />
      </mesh>

      {/* Wheels */}
      <group ref={wheelFLRef}>
        <Wheel position={[-0.45, 0.08, 0.45]} />
      </group>
      <group ref={wheelFRRef}>
        <Wheel position={[0.45, 0.08, 0.45]} />
      </group>
      <Wheel position={[-0.45, 0.08, -0.45]} />
      <Wheel position={[0.45, 0.08, -0.45]} />

      {/* Underglow */}
      <pointLight ref={glowRef} position={[0, 0.02, 0]} intensity={0.5} distance={2} color="#7b2ff7" />
    </group>
  );
}

function Ground() {
  const gridTexture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = "#1a1a3e";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 256; i += 16) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 256);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(256, i);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 8);
    return tex;
  }, []);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
      <planeGeometry args={[10, 10]} />
      <meshStandardMaterial map={gridTexture} transparent opacity={0.6} />
    </mesh>
  );
}

export default function CarScene({ velocity, turn, eStop }: CarModelProps) {
  return (
    <div className="w-full h-full">
      <Canvas
        camera={{ position: [2, 1.5, 2], fov: 45 }}
        gl={{ alpha: true, antialias: true }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.3} />
        <directionalLight position={[5, 5, 5]} intensity={0.8} />
        <directionalLight position={[-3, 3, -3]} intensity={0.3} color="#7b2ff7" />

        <Float speed={1.5} rotationIntensity={0.05} floatIntensity={0.3}>
          <CarBody velocity={velocity} turn={turn} eStop={eStop} />
        </Float>

        <Ground />
      </Canvas>
    </div>
  );
}
