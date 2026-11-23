//! 纯 Rust 解析 Dart/Flutter AOT 堆栈元数据与 ELF/Mach-O 符号文件的 Build ID。

use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

/// 从原始堆栈文本中提取的 AOT 特征信息。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AotStackInfo {
    pub is_aot: bool,
    pub build_id: Option<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
}

/// 识别堆栈是否为混淆/AOT 堆栈并提取其中的 build_id、平台与架构。
pub fn parse_aot_stack(stack_trace: &str) -> AotStackInfo {
    let mut info = AotStackInfo::default();
    let mut has_aot_frame = false;

    for raw_line in stack_trace.lines() {
        let line = raw_line.trim();
        if line.contains("isolate_instructions:")
            || line.contains("_kDartIsolateSnapshotInstructions")
            || line.contains("isolate_dso_base:")
        {
            info.is_aot = true;
        }
        if !has_aot_frame && is_aot_frame_line(line) {
            has_aot_frame = true;
            info.is_aot = true;
        }
        if info.build_id.is_none()
            && let Some(id) = extract_quoted_field(line, "build_id:")
        {
            let normalized = normalize_hex_id(&id);
            if !normalized.is_empty() {
                info.build_id = Some(normalized);
                info.is_aot = true;
            }
        }
        if (info.os.is_none() || info.arch.is_none())
            && line.contains("os:")
            && line.contains("arch:")
        {
            if info.os.is_none() {
                info.os = extract_token_after(line, "os:");
            }
            if info.arch.is_none() {
                info.arch = extract_token_after(line, "arch:");
            }
        }
    }

    info
}

fn is_aot_frame_line(line: &str) -> bool {
    let Some(rest) = line.strip_prefix('#') else {
        return false;
    };
    let mut parts = rest.split_whitespace();
    let Some(idx) = parts.next() else {
        return false;
    };
    if idx.is_empty() || !idx.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    matches!(parts.next(), Some("abs") | Some("virt"))
}

fn extract_quoted_field(line: &str, key: &str) -> Option<String> {
    let pos = line.find(key)?;
    let rest = line[pos + key.len()..].trim_start();
    if let Some(after_quote) = rest.strip_prefix('\'') {
        let end = after_quote.find('\'')?;
        return Some(after_quote[..end].to_string());
    }
    if let Some(after_quote) = rest.strip_prefix('"') {
        let end = after_quote.find('"')?;
        return Some(after_quote[..end].to_string());
    }
    let token = rest
        .split(|c: char| c.is_whitespace() || c == ',' || c == ')')
        .next()?;
    (!token.is_empty()).then(|| token.to_string())
}

fn extract_token_after(line: &str, key: &str) -> Option<String> {
    let pos = line.find(key)?;
    let rest = line[pos + key.len()..].trim_start();
    let token = rest
        .split(|c: char| c.is_whitespace() || c == ',' || c == ')')
        .next()?
        .trim_matches(|c| c == '\'' || c == '"');
    (!token.is_empty()).then(|| token.to_ascii_lowercase())
}

/// 统一去掉连字符并转为小写十六进制字符串。
pub fn normalize_hex_id(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X")
        .chars()
        .filter(|c| *c != '-')
        .collect();
    if !cleaned.is_empty() && cleaned.bytes().all(|b| b.is_ascii_hexdigit()) {
        cleaned.to_ascii_lowercase()
    } else {
        String::new()
    }
}

/// 从 ELF (.symbols) 或 Mach-O (dSYM/symbols) 符号文件中提取 Build ID / UUID。
pub fn extract_symbol_build_id(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).ok()?;
    file.seek(SeekFrom::Start(0)).ok()?;

    if magic == [0x7f, b'E', b'L', b'F'] {
        return extract_elf_build_id(&mut file);
    }
    match u32::from_be_bytes(magic) {
        0xfeed_face | 0xcefa_edfe | 0xfeed_facf | 0xcffa_edfe => extract_macho_uuid(&mut file, 0),
        0xcafe_babe => extract_fat_macho_uuid(&mut file),
        _ => None,
    }
}

fn read_u16(buf: &[u8], offset: usize, le: bool) -> Option<u16> {
    let bytes: [u8; 2] = buf.get(offset..offset + 2)?.try_into().ok()?;
    Some(if le {
        u16::from_le_bytes(bytes)
    } else {
        u16::from_be_bytes(bytes)
    })
}

fn read_u32(buf: &[u8], offset: usize, le: bool) -> Option<u32> {
    let bytes: [u8; 4] = buf.get(offset..offset + 4)?.try_into().ok()?;
    Some(if le {
        u32::from_le_bytes(bytes)
    } else {
        u32::from_be_bytes(bytes)
    })
}

fn read_u64(buf: &[u8], offset: usize, le: bool) -> Option<u64> {
    let bytes: [u8; 8] = buf.get(offset..offset + 8)?.try_into().ok()?;
    Some(if le {
        u64::from_le_bytes(bytes)
    } else {
        u64::from_be_bytes(bytes)
    })
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// 解析 ELF Program Header (PT_NOTE) 与 Section Header (SHT_NOTE) 查找 GNU Build ID。
fn extract_elf_build_id(file: &mut File) -> Option<String> {
    let mut header = [0u8; 64];
    let n = file.read(&mut header).ok()?;
    if n < 52 {
        return None;
    }
    let class = header[4]; // 1 = 32-bit, 2 = 64-bit
    let le = match header[5] {
        1 => true,
        2 => false,
        _ => return None,
    };

    let (phoff, phentsize, phnum, shoff, shentsize, shnum) = match class {
        1 => (
            read_u32(&header, 28, le)? as u64,
            read_u16(&header, 42, le)? as usize,
            read_u16(&header, 44, le)? as usize,
            read_u32(&header, 32, le)? as u64,
            read_u16(&header, 46, le)? as usize,
            read_u16(&header, 48, le)? as usize,
        ),
        2 if n >= 64 => (
            read_u64(&header, 32, le)?,
            read_u16(&header, 54, le)? as usize,
            read_u16(&header, 56, le)? as usize,
            read_u64(&header, 40, le)?,
            read_u16(&header, 58, le)? as usize,
            read_u16(&header, 60, le)? as usize,
        ),
        _ => return None,
    };

    // 优先检查 Program Headers 中的 PT_NOTE (type = 4)
    if phoff > 0 && phentsize >= 32 && phnum > 0 && phnum <= 256 {
        let mut ph_buf = vec![0u8; phentsize * phnum];
        if file.seek(SeekFrom::Start(phoff)).is_ok() && file.read_exact(&mut ph_buf).is_ok() {
            for i in 0..phnum {
                let entry = &ph_buf[i * phentsize..(i + 1) * phentsize];
                let p_type = read_u32(entry, 0, le)?;
                if p_type != 4 {
                    continue;
                }
                let (offset, size) = if class == 2 {
                    (read_u64(entry, 8, le)?, read_u64(entry, 32, le)?)
                } else {
                    (
                        read_u32(entry, 4, le)? as u64,
                        read_u32(entry, 16, le)? as u64,
                    )
                };
                if let Some(id) = parse_elf_note_region(file, offset, size, le) {
                    return Some(id);
                }
            }
        }
    }

    // 回退检查 Section Headers 中的 SHT_NOTE (type = 7)
    if shoff > 0 && shentsize >= 40 && shnum > 0 && shnum <= 512 {
        let mut sh_buf = vec![0u8; shentsize * shnum];
        if file.seek(SeekFrom::Start(shoff)).is_ok() && file.read_exact(&mut sh_buf).is_ok() {
            for i in 0..shnum {
                let entry = &sh_buf[i * shentsize..(i + 1) * shentsize];
                let sh_type = read_u32(entry, 4, le)?;
                if sh_type != 7 {
                    continue;
                }
                let (offset, size) = if class == 2 {
                    (read_u64(entry, 24, le)?, read_u64(entry, 32, le)?)
                } else {
                    (
                        read_u32(entry, 16, le)? as u64,
                        read_u32(entry, 20, le)? as u64,
                    )
                };
                if let Some(id) = parse_elf_note_region(file, offset, size, le) {
                    return Some(id);
                }
            }
        }
    }

    None
}

fn align4(value: usize) -> usize {
    (value + 3) & !3
}

fn parse_elf_note_region(file: &mut File, offset: u64, size: u64, le: bool) -> Option<String> {
    if size == 0 || size > 128 * 1024 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    file.seek(SeekFrom::Start(offset)).ok()?;
    file.read_exact(&mut data).ok()?;

    let mut pos = 0usize;
    while pos + 12 <= data.len() {
        let namesz = read_u32(&data, pos, le)? as usize;
        let descsz = read_u32(&data, pos + 4, le)? as usize;
        let ntype = read_u32(&data, pos + 8, le)?;
        pos += 12;

        let name_aligned = align4(namesz);
        let desc_aligned = align4(descsz);
        if pos.checked_add(name_aligned)?.checked_add(desc_aligned)? > data.len() {
            break;
        }
        let name = &data[pos..pos + namesz];
        let desc_start = pos + name_aligned;
        let desc = &data[desc_start..desc_start + descsz];
        // NT_GNU_BUILD_ID = 3，名称为 "GNU\0"
        if ntype == 3 && (name == b"GNU\0" || name == b"GNU") && !desc.is_empty() {
            return Some(hex_encode(desc));
        }
        pos = desc_start + desc_aligned;
    }
    None
}

fn extract_fat_macho_uuid(file: &mut File) -> Option<String> {
    let mut header = [0u8; 8];
    file.read_exact(&mut header).ok()?;
    let nfat = u32::from_be_bytes(header[4..8].try_into().ok()?) as usize;
    if nfat == 0 || nfat > 16 {
        return None;
    }
    let mut arch_buf = vec![0u8; nfat * 20];
    file.read_exact(&mut arch_buf).ok()?;
    for i in 0..nfat {
        let offset = u32::from_be_bytes(arch_buf[i * 20 + 8..i * 20 + 12].try_into().ok()?) as u64;
        if let Some(uuid) = extract_macho_uuid(file, offset) {
            return Some(uuid);
        }
    }
    None
}

/// 解析 Mach-O Load Commands 中的 LC_UUID (0x1B)。
fn extract_macho_uuid(file: &mut File, base_offset: u64) -> Option<String> {
    file.seek(SeekFrom::Start(base_offset)).ok()?;
    let mut header = [0u8; 32];
    file.read_exact(&mut header).ok()?;
    let magic = u32::from_be_bytes(header[0..4].try_into().ok()?);
    let (le, is_64) = match magic {
        0xfeed_face => (false, false),
        0xcefa_edfe => (true, false),
        0xfeed_facf => (false, true),
        0xcffa_edfe => (true, true),
        _ => return None,
    };
    let ncmds = read_u32(&header, 16, le)? as usize;
    let sizeofcmds = read_u32(&header, 20, le)? as usize;
    if ncmds == 0 || sizeofcmds == 0 || sizeofcmds > 1024 * 1024 {
        return None;
    }
    let cmd_offset = base_offset + if is_64 { 32 } else { 28 };
    file.seek(SeekFrom::Start(cmd_offset)).ok()?;
    let mut cmds = vec![0u8; sizeofcmds];
    file.read_exact(&mut cmds).ok()?;

    let mut pos = 0usize;
    for _ in 0..ncmds {
        if pos + 8 > cmds.len() {
            break;
        }
        let cmd = read_u32(&cmds, pos, le)?;
        let cmdsize = read_u32(&cmds, pos + 4, le)? as usize;
        if cmdsize < 8 || pos + cmdsize > cmds.len() {
            break;
        }
        // LC_UUID = 0x1B，载荷为 16 字节 UUID
        if cmd == 0x1b && cmdsize >= 24 {
            return Some(hex_encode(&cmds[pos + 8..pos + 24]));
        }
        pos += cmdsize;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_flutter_aot_stack_metadata() {
        let sample = "\
Warning: This VM has been configured to produce stack traces that violate the Dart standard.
*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
pid: 1234, tid: 5678, name io.flutter.1.ui
os: ios arch: arm64 comp: yes sim: no
build_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
isolate_dso_base: 104c00000, vm_dso_base: 104c00000
isolate_instructions: 104c10000, vm_instructions: 104c04000
    #00 abs 0000000104e2a1bc virt 000000000022a1bc _kDartIsolateSnapshotInstructions+0x21a1bc
    #01 abs 0000000104e2a204 virt 000000000022a204 _kDartIsolateSnapshotInstructions+0x21a204
";
        let info = parse_aot_stack(sample);
        assert!(info.is_aot);
        assert_eq!(
            info.build_id.as_deref(),
            Some("a1b2c3d4e5f60718293a4b5c6d7e8f90")
        );
        assert_eq!(info.os.as_deref(), Some("ios"));
        assert_eq!(info.arch.as_deref(), Some("arm64"));
    }

    #[test]
    fn extracts_gnu_build_id_from_synthetic_elf64() {
        // 构造带单个 PT_NOTE 段的最小 64 位小端 ELF 文件
        let mut elf = vec![0u8; 64 + 56 + 32];
        elf[0..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
        elf[4] = 2; // ELF64
        elf[5] = 1; // Little-Endian
        elf[32..40].copy_from_slice(&64u64.to_le_bytes()); // e_phoff = 64
        elf[54..56].copy_from_slice(&56u16.to_le_bytes()); // e_phentsize = 56
        elf[56..58].copy_from_slice(&1u16.to_le_bytes()); // e_phnum = 1

        // Program Header: PT_NOTE (4), offset=120, filesz=32
        let ph = &mut elf[64..120];
        ph[0..4].copy_from_slice(&4u32.to_le_bytes());
        ph[8..16].copy_from_slice(&120u64.to_le_bytes());
        ph[32..40].copy_from_slice(&32u64.to_le_bytes());

        // Note: namesz=4 ("GNU\0"), descsz=16, type=3 (NT_GNU_BUILD_ID)
        let note = &mut elf[120..152];
        note[0..4].copy_from_slice(&4u32.to_le_bytes());
        note[4..8].copy_from_slice(&16u32.to_le_bytes());
        note[8..12].copy_from_slice(&3u32.to_le_bytes());
        note[12..16].copy_from_slice(b"GNU\0");
        let expected: [u8; 16] = [
            0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc,
            0xba, 0x98,
        ];
        note[16..32].copy_from_slice(&expected);

        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(&elf).unwrap();
        assert_eq!(
            extract_symbol_build_id(tmp.path()).as_deref(),
            Some("deadbeef0123456789abcdeffedcba98")
        );
    }
}
