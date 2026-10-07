import { Square, Video, Music, Type, Shapes, Sticker, LayoutTemplate, UploadCloud, Images, MessageSquare } from 'lucide-react';

export function Sidebar() {
  const items = [
    { label: 'Templates', icon: <LayoutTemplate size={20} /> },
    { label: 'Elements', icon: <Square size={20} /> },
    { label: 'Uploads', icon: <UploadCloud size={20} /> },
    { label: 'Captions', icon: <MessageSquare size={20} /> },
    { label: 'Images', icon: <Images size={20} /> },
    { label: 'Videos', icon: <Video size={20} /> },
    { label: 'Audio', icon: <Music size={20} /> },
    { label: 'Text', icon: <Type size={20} /> },
    { label: 'Shapes', icon: <Shapes size={20} /> },
    { label: 'Stickers', icon: <Sticker size={20} /> },
  ];

  return (
    <div className="sidebar" style={{ width: '72px', borderRight: '1px solid #333', backgroundColor: '#1a1a1a', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0', gap: '4px', overflowY: 'auto' }}>
      {items.map((item) => (
        <button
          key={item.label}
          style={{ width: '56px', height: '56px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: '#999', cursor: 'pointer', borderRadius: '8px', gap: '4px' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.backgroundColor = '#333'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#999'; e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          {item.icon}
          <span style={{ fontSize: '10px' }}>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

