//! Local interface lookup is independent of listeners and the credential vault.
use crate::protocol::session::Result;
use std::{collections::HashSet, net::IpAddr};

pub fn local_addresses() -> Result<Vec<String>> {
    let interfaces =
        local_ip_address::list_afinet_netifas().map_err(|_| "localAddressesUnavailable")?;
    Ok(select_addresses(
        interfaces,
        local_ip_address::local_ip().ok(),
    ))
}
fn select_addresses(interfaces: Vec<(String, IpAddr)>, primary: Option<IpAddr>) -> Vec<String> {
    let mut found = interfaces
        .into_iter()
        .filter_map(|(name, ip)| {
            let IpAddr::V4(ipv4) = ip else {
                return None;
            };
            let name = name.to_lowercase();
            if ipv4.is_loopback()
                || ipv4.is_unspecified()
                || ipv4.is_link_local()
                || ipv4.is_multicast()
                || ipv4.is_broadcast()
                || [
                    "utun",
                    "awdl",
                    "llw",
                    "ipsec",
                    "tun",
                    "tap",
                    "wg",
                    "tailscale",
                    "docker",
                    "veth",
                    "virbr",
                    "vboxnet",
                    "vmnet",
                ]
                .iter()
                .any(|prefix| name.starts_with(prefix))
            {
                return None;
            }
            let physical = ["en", "eth", "wlan", "wlp", "wi-fi", "wifi", "以太网"]
                .iter()
                .any(|prefix| name.starts_with(prefix));
            Some((!physical, Some(ip) != primary, name, ipv4))
        })
        .collect::<Vec<_>>();
    found.sort();
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter_map(|(_, _, _, ip)| seen.insert(ip).then(|| ip.to_string()))
        .take(16)
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_addresses_precede_bridges_and_tunnels_are_not_connection_targets() {
        let entries = [
            ("utun0", "10.0.0.1"),
            ("bridge100", "192.168.64.1"),
            ("en0", "192.168.1.8"),
            ("en1", "10.1.1.9"),
            ("en0", "192.168.1.8"),
            ("lo0", "127.0.0.1"),
            ("en2", "0.0.0.0"),
            ("en3", "169.254.1.2"),
            ("en4", "::1"),
        ];
        let items = entries
            .into_iter()
            .map(|(name, ip)| (name.into(), ip.parse().unwrap()))
            .collect();
        assert_eq!(
            select_addresses(items, Some("10.0.0.1".parse().unwrap())),
            ["192.168.1.8", "10.1.1.9", "192.168.64.1"]
        );
    }
    #[test]
    fn primary_physical_ip_is_first_and_unknown_or_empty_interfaces_stay_bounded() {
        let mut items = (1..=32)
            .map(|last| ("Ethernet".into(), IpAddr::from([10, 0, 0, last])))
            .collect::<Vec<_>>();
        items.push(("Wi-Fi".into(), "192.168.1.8".parse().unwrap()));
        let addresses = select_addresses(items, Some("192.168.1.8".parse().unwrap()));
        assert_eq!(addresses.len(), 16);
        assert_eq!(addresses[0], "192.168.1.8");
        assert!(select_addresses(Vec::new(), None).is_empty());
    }
}
