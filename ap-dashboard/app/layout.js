import './globals.css';

export const metadata = {
  title: 'RC Partners | Dashboard AP',
  description: 'Sistema de gestión y análisis de cuentas comitentes para Agentes Productores',
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
