
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  isBotSpeaking: boolean;
}

export const Visualizer: React.FC<VisualizerProps> = ({ isActive, isBotSpeaking }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrame: number;
    let offset = 0;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      if (!isActive) {
        ctx.beginPath();
        ctx.moveTo(0, canvas.height / 2);
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
      }

      const amplitude = isBotSpeaking ? 40 : 20;
      const color = isBotSpeaking ? '#6366f1' : '#10b981';
      
      ctx.beginPath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';

      for (let x = 0; x < canvas.width; x++) {
        const y = canvas.height / 2 + Math.sin(x * 0.05 + offset) * amplitude * Math.sin(x * 0.01);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.stroke();
      offset += 0.1;
      animationFrame = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animationFrame);
  }, [isActive, isBotSpeaking]);

  return (
    <div className="w-full h-32 flex items-center justify-center bg-white rounded-2xl shadow-inner border border-slate-100 overflow-hidden">
      <canvas ref={canvasRef} width={600} height={128} className="w-full h-full opacity-80" />
    </div>
  );
};
