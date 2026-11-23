use std::io;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopbackAddr(SocketAddr);

impl LoopbackAddr {
    #[cfg(test)]
    pub fn at_port(port: u16) -> Self {
        Self(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
    }

    pub fn reserve_free_port() -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        Ok(Self(listener.local_addr()?))
    }

    pub fn socket_addr(self) -> SocketAddr {
        self.0
    }

    pub fn url(self) -> String {
        format!("http://{}/", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reserved_port_is_loopback_and_free_to_bind_again() {
        let address = LoopbackAddr::reserve_free_port().unwrap();
        assert!(address.socket_addr().ip().is_loopback());
        assert_ne!(address.socket_addr().port(), 0);
        TcpListener::bind(address.socket_addr()).unwrap();
    }

    #[test]
    fn the_url_names_the_reserved_address() {
        let address = LoopbackAddr::at_port(4321);
        assert_eq!(address.url(), "http://127.0.0.1:4321/");
    }
}
