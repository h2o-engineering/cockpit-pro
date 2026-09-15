//! Windows back-end of `archive_durable_write::confined` — the frozen T01
//! contract §9 realization.
//!
//! Every governed open below is a relative `NtCreateFile` with
//! `OBJECT_ATTRIBUTES.RootDirectory` set to an already-admitted directory
//! handle, `OBJ_DONT_REPARSE` (never retried without it — a host that rejects
//! the attribute fails closed), `OBJ_CASE_INSENSITIVE` (Win32 parity) and
//! `FILE_OPEN_REPARSE_POINT`, followed by `FileAttributeTagInfo`
//! classification: ANY reparse point (symlink, junction, mount point, cloud
//! placeholder, AppExecLink, …) standing at a governed component is opened as
//! itself and refused, never traversed. Publication and moves act on HANDLES
//! (`SetFileInformationByHandle` / `FileRenameInfo` with `ReplaceIfExists =
//! FALSE` and a `RootDirectory` handle), so no Win32 pathname API performs
//! any governed mutation and no check-then-act sequence exists.
//!
//! Durability fences are `FlushFileBuffers` through the retained WRITE handle
//! (files) and through the parent directory handle opened with write access
//! (namespace); the directory-flush capability is PROVEN by the class O probe
//! before any publication relies on it. Presence is `LockFileEx` on the lock
//! file opened relative to the root without `FILE_SHARE_DELETE`.
//!
//! This is compile-arm honesty, not certification: native NTFS behaviour is
//! established by the Mission's T03/T05 evidence, never by this module.

use crate::archive_durable_write::confined::{
    DeclaredVolumeCapabilities, EntryKind, EntryStat, LinkByHandleSpelling, ObjectIdentity,
    ResourceError,
};
use std::fs::File;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;

use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
    FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, RtlNtStatusToDosError, ERROR_ALREADY_EXISTS, ERROR_CANT_ACCESS_FILE,
    ERROR_DIRECTORY, ERROR_DISK_FULL, ERROR_FILE_EXISTS, ERROR_FILE_TOO_LARGE,
    ERROR_HANDLE_DISK_FULL, ERROR_INVALID_PARAMETER, ERROR_LOCK_VIOLATION, ERROR_NOT_SAME_DEVICE,
    ERROR_NOT_SUPPORTED, ERROR_NO_MORE_FILES, ERROR_STOPPED_ON_SYMLINK, HANDLE,
    INVALID_HANDLE_VALUE, NTSTATUS, STATUS_SUCCESS, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileAttributeTagInfo, FileDispositionInfo, FileDispositionInfoEx,
    FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, FileIdInfo, FileRenameInfo,
    FileRenameInfoEx, FileStandardInfo, FlushFileBuffers, GetDiskFreeSpaceExW,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, GetVolumeInformationByHandleW,
    LockFileEx, SetFileInformationByHandle, UnlockFileEx, DELETE, FILE_ADD_FILE,
    FILE_ADD_SUBDIRECTORY, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_FLAG_DELETE,
    FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_ID_BOTH_DIR_INFO, FILE_ID_INFO, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_STANDARD_INFO, FILE_TRAVERSE, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    OPEN_EXISTING, SYNCHRONIZE, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::Kernel::{OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE};
use windows_sys::Win32::System::WindowsProgramming::{
    FILE_RENAME_FLAG_POSIX_SEMANTICS, FILE_RENAME_FLAG_REPLACE_IF_EXISTS,
};
use windows_sys::Win32::System::IO::{IO_STATUS_BLOCK, OVERLAPPED};

/// `FILE_RENAME_IGNORE_READONLY_ATTRIBUTE` from `ntifs.h` (documented value
/// 0x40; not exported by `windows-sys 0.59`). Used only in class I, exactly
/// as Rust std does for its own replacing rename.
const FILE_RENAME_FLAG_IGNORE_READONLY_ATTRIBUTE: u32 = 0x40;

/// Share mode used for every governed directory and read handle so fences and
/// cross-checks never conflict with concurrent opens.
const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

/// Access requested on every admitted directory object: enumerate, traverse,
/// create children, read attributes, serve as a rename source, synchronize.
/// `FILE_ADD_FILE` is write access, which the namespace fence requires.
const DIR_ACCESS: u32 = FILE_LIST_DIRECTORY
    | FILE_TRAVERSE
    | FILE_ADD_FILE
    | FILE_ADD_SUBDIRECTORY
    | FILE_READ_ATTRIBUTES
    | DELETE
    | SYNCHRONIZE;

fn win_err(code: u32) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}

fn last_err() -> io::Error {
    win_err(unsafe { GetLastError() })
}

/// Maps an `NTSTATUS` to the `io::Error` Win32 would have produced, so
/// `err.kind()` (NotFound / AlreadyExists / PermissionDenied / …) keeps the
/// same meaning as for every other Windows I/O error.
fn nt_err(status: NTSTATUS) -> io::Error {
    win_err(unsafe { RtlNtStatusToDosError(status) })
}

/// Refusal of a component that is a reparse point (link / junction / mount
/// point / placeholder) — the Windows spelling of `ELOOP`.
fn reparse_refusal() -> io::Error {
    win_err(ERROR_CANT_ACCESS_FILE)
}

/// Refusal of a component that is not a directory where one is required —
/// the Windows spelling of `ENOTDIR`.
fn not_a_directory() -> io::Error {
    win_err(ERROR_DIRECTORY)
}

/// A governed component: one name, no separators, no NUL, valid UTF-8 (every
/// governed leaf is ASCII by contract; names read back from the directory
/// are UTF-8 round-trips of their UTF-16 form).
fn to_wide(name: &[u8]) -> io::Result<Vec<u16>> {
    if name.is_empty()
        || name.contains(&b'\\')
        || name.contains(&b'/')
        || name.contains(&0)
        || name == b"."
        || name == b".."
    {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let text =
        std::str::from_utf8(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    Ok(text.encode_utf16().collect())
}

fn path_wide_nul(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// One relative `NtCreateFile`. `OBJ_DONT_REPARSE` is set unconditionally and
/// NEVER retried without it: a host that refuses the attribute
/// (`STATUS_INVALID_PARAMETER`, below the Windows 10 1607 floor) fails closed.
fn nt_create_relative(
    root: HANDLE,
    name: &[u16],
    access: u32,
    attributes: u32,
    share: u32,
    disposition: u32,
    options: u32,
) -> io::Result<OwnedHandle> {
    let byte_len = name.len() * 2;
    if byte_len > u16::MAX as usize {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let unicode = UNICODE_STRING {
        Length: byte_len as u16,
        MaximumLength: byte_len as u16,
        Buffer: name.as_ptr() as *mut u16,
    };
    let object = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: root,
        ObjectName: &unicode,
        Attributes: (OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE) as u32,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut handle: HANDLE = INVALID_HANDLE_VALUE;
    let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    // SAFETY: every pointer refers to a live local for the duration of the
    // call; `root` is a live handle owned by the caller.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &object,
            &mut iosb,
            std::ptr::null(),
            attributes,
            share,
            disposition,
            options,
            std::ptr::null(),
            0,
        )
    };
    if status != STATUS_SUCCESS {
        return Err(nt_err(status));
    }
    // SAFETY: NtCreateFile succeeded, so `handle` is a valid open handle we own.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) })
}

fn attribute_tag(handle: HANDLE) -> io::Result<FILE_ATTRIBUTE_TAG_INFO> {
    let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(last_err());
    }
    Ok(info)
}

fn standard_info(handle: HANDLE) -> io::Result<FILE_STANDARD_INFO> {
    let mut info: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(last_err());
    }
    Ok(info)
}

fn identity_of(handle: HANDLE) -> io::Result<ObjectIdentity> {
    let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(last_err());
    }
    Ok(ObjectIdentity {
        device: info.VolumeSerialNumber,
        object: u128::from_le_bytes(info.FileId.Identifier),
    })
}

/// Classifies an opened object: ANY reparse tag counts as a link.
fn kind_of(handle: HANDLE) -> io::Result<EntryKind> {
    let tag = attribute_tag(handle)?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(EntryKind::Symlink);
    }
    if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return Ok(EntryKind::Directory);
    }
    Ok(EntryKind::Regular)
}

fn entry_stat_of(handle: HANDLE) -> io::Result<EntryStat> {
    let kind = kind_of(handle)?;
    let identity = identity_of(handle)?;
    let size = match kind {
        EntryKind::Regular => {
            let std_info = standard_info(handle)?;
            if std_info.EndOfFile < 0 {
                0
            } else {
                std_info.EndOfFile as u64
            }
        }
        _ => 0,
    };
    Ok(EntryStat::new(kind, identity, size))
}

fn flush(handle: HANDLE) -> io::Result<()> {
    if unsafe { FlushFileBuffers(handle) } == 0 {
        return Err(last_err());
    }
    Ok(())
}

/// Identity of an open file object (volume serial + 128-bit file id), read
/// from the handle itself — never from a pathname.
pub fn file_identity(file: &File) -> io::Result<ObjectIdentity> {
    identity_of(file.as_raw_handle() as HANDLE)
}

/// Class J: `FlushFileBuffers` through the retained WRITE handle — file data
/// and metadata are written and the storage is synchronized to flush its
/// cache. Reported `false` because the flag names the macOS `F_FULLFSYNC`
/// fence specifically, NOT because the write is less durable (contract §11.3).
/// The handle must hold write access; a read-only reopen cannot fence.
pub fn sync_file_contents(file: &File) -> io::Result<bool> {
    flush(file.as_raw_handle() as HANDLE)?;
    Ok(false)
}

/// A component that is a reparse point, or not a directory where one is
/// required, was refused — never followed.
pub fn is_redirect_refusal(err: &io::Error) -> bool {
    matches!(
        err.raw_os_error().map(|c| c as u32),
        Some(ERROR_CANT_ACCESS_FILE) | Some(ERROR_STOPPED_ON_SYMLINK) | Some(ERROR_DIRECTORY)
    )
}

/// The platform refused a primitive as unavailable on this filesystem, host
/// or volume pairing (`STATUS_INVALID_PARAMETER`, `STATUS_NOT_SUPPORTED`,
/// `STATUS_NOT_SAME_DEVICE`), plus the facade's own compile-time marker.
pub fn is_capability_absent(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::Unsupported
        || matches!(
            err.raw_os_error().map(|c| c as u32),
            Some(ERROR_INVALID_PARAMETER) | Some(ERROR_NOT_SUPPORTED) | Some(ERROR_NOT_SAME_DEVICE)
        )
}

pub fn resource_error(err: &io::Error) -> Option<ResourceError> {
    // ERROR_DISK_QUOTA_EXCEEDED (1295) and ERROR_NOT_ENOUGH_QUOTA (1816).
    match err.raw_os_error().map(|c| c as u32) {
        Some(ERROR_DISK_FULL) | Some(ERROR_HANDLE_DISK_FULL) => Some(ResourceError::NoSpace),
        Some(1295) | Some(1816) => Some(ResourceError::Quota),
        Some(ERROR_FILE_TOO_LARGE) => Some(ResourceError::FileTooLarge),
        _ => None,
    }
}

fn lock_file(handle: HANDLE, flags: u32) -> io::Result<()> {
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let ok = unsafe { LockFileEx(handle, flags, 0, 1, 0, &mut overlapped) };
    if ok == 0 {
        return Err(last_err());
    }
    Ok(())
}

fn unlock_quietly(handle: HANDLE) {
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    // A handle that holds no lock reports ERROR_NOT_LOCKED; that is the
    // expected state before a first acquisition and is deliberately ignored.
    let _ = unsafe { UnlockFileEx(handle, 0, 1, 0, &mut overlapped) };
}

/// Class N: non-blocking SHARED presence (one byte at offset 0). Windows
/// has no in-place lock conversion, so any lock this handle holds is released
/// first: the conversion is unlock + lock and therefore non-atomic — exactly
/// the contract every Unix `flock` documents — and only a successful
/// acquisition is a proof point.
pub fn lock_shared(file: &File) -> io::Result<()> {
    let handle = file.as_raw_handle() as HANDLE;
    unlock_quietly(handle);
    lock_file(handle, LOCKFILE_FAIL_IMMEDIATELY)
}

/// Class N: non-blocking EXCLUSIVE presence (unlock + lock, see above).
pub fn lock_exclusive(file: &File) -> io::Result<()> {
    let handle = file.as_raw_handle() as HANDLE;
    unlock_quietly(handle);
    lock_file(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)
}

pub fn unlock(file: &File) -> io::Result<()> {
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let ok = unsafe { UnlockFileEx(file.as_raw_handle() as HANDLE, 0, 1, 0, &mut overlapped) };
    if ok == 0 {
        return Err(last_err());
    }
    Ok(())
}

pub fn lock_would_block(err: &io::Error) -> bool {
    err.raw_os_error().map(|c| c as u32) == Some(ERROR_LOCK_VIOLATION)
        || err.kind() == io::ErrorKind::WouldBlock
}

/// Builds a `FILE_RENAME_INFO` (variable-length, pointer-aligned) in an
/// 8-byte-aligned buffer. Returns the buffer and its meaningful byte length.
fn rename_info_buffer(
    root: HANDLE,
    target: &[u16],
    replace_flags: Option<u32>,
) -> (Vec<u64>, usize) {
    let header = std::mem::size_of::<FILE_RENAME_INFO>();
    let name_bytes = target.len() * 2;
    // The struct already reserves one u16 for FileName; allocate the rest.
    let total = header + name_bytes;
    let mut buf = vec![0u64; total.div_ceil(8)];
    // SAFETY: the buffer is at least `header` bytes long and 8-byte aligned,
    // so the struct's fields may be written through an aligned pointer; the
    // name is copied into the trailing flexible array with the exact length
    // recorded in FileNameLength.
    unsafe {
        let info = buf.as_mut_ptr() as *mut FILE_RENAME_INFO;
        match replace_flags {
            Some(flags) => (*info).Anonymous.Flags = flags,
            None => (*info).Anonymous.ReplaceIfExists = 0,
        }
        (*info).RootDirectory = root;
        (*info).FileNameLength = name_bytes as u32;
        let name_ptr = std::ptr::addr_of_mut!((*info).FileName) as *mut u16;
        std::ptr::copy_nonoverlapping(target.as_ptr(), name_ptr, target.len());
    }
    (buf, total)
}

fn info_bytes(buf: &[u64], len: usize) -> &[u8] {
    // SAFETY: `buf` owns at least `len` initialized bytes.
    unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, len) }
}

fn set_information(handle: HANDLE, class: i32, buf: &[u8]) -> io::Result<()> {
    let ok = unsafe {
        SetFileInformationByHandle(
            handle,
            class,
            buf.as_ptr() as *const core::ffi::c_void,
            buf.len() as u32,
        )
    };
    if ok == 0 {
        return Err(last_err());
    }
    Ok(())
}

/// Class F/G/M: handle-bound NO-REPLACE rename of the object `source` names
/// into `root`/`target`. `ReplaceIfExists = FALSE` and no POSIX flag: the
/// existence test and the insertion are one rename under the parent's lock.
/// `Ok(false)` on collision.
fn rename_no_replace(source: HANDLE, root: HANDLE, target: &[u16]) -> io::Result<bool> {
    let (buf, len) = rename_info_buffer(root, target, None);
    match set_information(source, FileRenameInfo, info_bytes(&buf, len)) {
        Ok(()) => Ok(true),
        Err(err)
            if matches!(
                err.raw_os_error().map(|c| c as u32),
                Some(ERROR_ALREADY_EXISTS) | Some(ERROR_FILE_EXISTS)
            ) =>
        {
            Ok(false)
        }
        Err(err) => Err(err),
    }
}

/// Deletes the object `handle` names — the link object itself, never its
/// target. POSIX semantics (Windows 10 1709+) with the documented legacy
/// disposition fallback when the Ex class is refused.
fn delete_by_handle(handle: HANDLE) -> io::Result<()> {
    let ex = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    let ex_bytes = unsafe {
        std::slice::from_raw_parts(
            &ex as *const _ as *const u8,
            std::mem::size_of::<FILE_DISPOSITION_INFO_EX>(),
        )
    };
    match set_information(handle, FileDispositionInfoEx, ex_bytes) {
        Ok(()) => return Ok(()),
        Err(err)
            if matches!(
                err.raw_os_error().map(|c| c as u32),
                Some(ERROR_INVALID_PARAMETER) | Some(ERROR_NOT_SUPPORTED)
            ) => {}
        Err(err) => return Err(err),
    }
    let legacy = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    let legacy_bytes = unsafe {
        std::slice::from_raw_parts(
            &legacy as *const _ as *const u8,
            std::mem::size_of::<FILE_DISPOSITION_INFO>(),
        )
    };
    set_information(handle, FileDispositionInfo, legacy_bytes)
}

/// An open directory handle. Dropping it closes the handle.
pub struct Dir(OwnedHandle);

impl Dir {
    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle() as HANDLE
    }

    /// Opens the trusted prefix (Tauri's resolver output — never renderer
    /// input) as a directory with backup semantics. Symlinks inside the
    /// trusted prefix are followed by the same design as macOS.
    fn open_trusted_dir(path: &Path) -> io::Result<Dir> {
        let wide = path_wide_nul(path);
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE,
                SHARE_ALL,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(last_err());
        }
        Ok(Dir(unsafe {
            OwnedHandle::from_raw_handle(handle as RawHandle)
        }))
    }

    /// Class A: admits the governed root leaf as a directory object, creating
    /// it when absent (creating entry points only). A reparse point standing
    /// where the leaf belongs is opened as itself and refused.
    pub fn open_root(path: &Path) -> io::Result<Dir> {
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        std::fs::create_dir_all(parent)?;
        let parent_dir = Dir::open_trusted_dir(parent)?;
        parent_dir.mkdir_child(name.as_bytes())?;
        parent_dir.open_child_nofollow(name.as_bytes())
    }

    /// Class A, non-creating: admits an EXISTING governed root for a read-only
    /// probe; a missing root reports `NotFound` rather than being created.
    pub fn open_existing_nofollow(path: &Path) -> io::Result<Dir> {
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let parent_dir = Dir::open_trusted_dir(parent)?;
        parent_dir.open_child_nofollow(name.as_bytes())
    }

    /// Class B: opens one child component relative to this handle. Opened
    /// with `FILE_OPEN_REPARSE_POINT` so a junction / symlink standing at the
    /// name is the object opened, then refused by its attributes; a
    /// non-directory is refused too.
    pub fn open_child_nofollow(&self, name: &[u8]) -> io::Result<Dir> {
        let wide = to_wide(name)?;
        let handle = nt_create_relative(
            self.raw(),
            &wide,
            DIR_ACCESS,
            0,
            SHARE_ALL,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        )?;
        match kind_of(handle.as_raw_handle() as HANDLE)? {
            EntryKind::Directory => Ok(Dir(handle)),
            EntryKind::Symlink => Err(reparse_refusal()),
            _ => Err(not_a_directory()),
        }
    }

    /// Creates a child directory; an existing entry is tolerated here and
    /// rejected by the subsequent no-follow open if it is not a real directory.
    pub fn mkdir_child(&self, name: &[u8]) -> io::Result<()> {
        match self.mkdir_child_exclusive(name) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            Err(err) => Err(err),
        }
    }

    /// Class E: exclusive directory creation. `OBJ_DONT_REPARSE` makes a
    /// reparse point standing at the name a refusal
    /// (`STATUS_REPARSE_POINT_ENCOUNTERED`), reported like a collision so no
    /// caller ever adopts it.
    pub fn mkdir_child_exclusive(&self, name: &[u8]) -> io::Result<()> {
        let wide = to_wide(name)?;
        match nt_create_relative(
            self.raw(),
            &wide,
            DIR_ACCESS,
            0,
            SHARE_ALL,
            FILE_CREATE,
            FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
        ) {
            Ok(_handle) => Ok(()),
            Err(err) if is_redirect_refusal(&err) => Err(win_err(ERROR_ALREADY_EXISTS)),
            Err(err) => Err(err),
        }
    }

    /// Class C: reports the entry's own type without following it. `None`
    /// when absent.
    pub fn stat_child_nofollow(&self, name: &[u8]) -> io::Result<Option<EntryStat>> {
        let wide = to_wide(name)?;
        let handle = match nt_create_relative(
            self.raw(),
            &wide,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            0,
            SHARE_ALL,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        ) {
            Ok(handle) => handle,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        Ok(Some(entry_stat_of(handle.as_raw_handle() as HANDLE)?))
    }

    /// Class D: exclusive regular-file creation with the handle retained
    /// through write, fence, verification and publication. `ShareAccess = 0`
    /// blocks foreign opens of staging; a reparse point at the name is a
    /// collision, never a redirected create.
    pub fn create_new_child(&self, name: &[u8]) -> io::Result<File> {
        let wide = to_wide(name)?;
        let handle = match nt_create_relative(
            self.raw(),
            &wide,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | SYNCHRONIZE,
            FILE_ATTRIBUTE_NORMAL,
            0,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        ) {
            Ok(handle) => handle,
            Err(err) if is_redirect_refusal(&err) => return Err(win_err(ERROR_ALREADY_EXISTS)),
            Err(err) => return Err(err),
        };
        Ok(File::from(handle))
    }

    /// Windows has no anonymous-inode create; publication is handle-bound by
    /// rename instead (class F), so nothing is lost.
    pub fn create_anonymous_child(&self) -> io::Result<File> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }

    /// Class C: opens a child regular file for reading without following a
    /// reparse point; a directory or link is refused.
    pub fn open_child_read_nofollow(&self, name: &[u8]) -> io::Result<File> {
        let wide = to_wide(name)?;
        let handle = nt_create_relative(
            self.raw(),
            &wide,
            FILE_GENERIC_READ | SYNCHRONIZE,
            0,
            SHARE_ALL,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        )?;
        match kind_of(handle.as_raw_handle() as HANDLE)? {
            EntryKind::Regular | EntryKind::Other => Ok(File::from(handle)),
            EntryKind::Symlink => Err(reparse_refusal()),
            EntryKind::Directory => Err(not_a_directory()),
        }
    }

    /// Class I: controlled same-directory REPLACEMENT of a proven-mismatching
    /// regular file, on the STAGING handle (`FileRenameInfoEx` with POSIX
    /// semantics; the documented `ReplaceIfExists = TRUE` legacy class where
    /// the Ex class is refused). Reserved for the CAS repair path.
    pub fn replace_within(&self, staging: &File, _from: &[u8], to: &[u8]) -> io::Result<()> {
        let wide = to_wide(to)?;
        let source = staging.as_raw_handle() as HANDLE;
        let (ex, ex_len) = rename_info_buffer(
            self.raw(),
            &wide,
            Some(
                FILE_RENAME_FLAG_REPLACE_IF_EXISTS
                    | FILE_RENAME_FLAG_POSIX_SEMANTICS
                    | FILE_RENAME_FLAG_IGNORE_READONLY_ATTRIBUTE,
            ),
        );
        match set_information(source, FileRenameInfoEx, info_bytes(&ex, ex_len)) {
            Ok(()) => return Ok(()),
            Err(err)
                if matches!(
                    err.raw_os_error().map(|c| c as u32),
                    Some(ERROR_INVALID_PARAMETER) | Some(ERROR_NOT_SUPPORTED)
                ) => {}
            Err(err) => return Err(err),
        }
        let (mut legacy, legacy_len) = rename_info_buffer(self.raw(), &wide, None);
        // ReplaceIfExists = TRUE: the BOOLEAN is the first byte of the union.
        unsafe {
            (*(legacy.as_mut_ptr() as *mut FILE_RENAME_INFO))
                .Anonymous
                .ReplaceIfExists = 1;
        }
        set_information(source, FileRenameInfo, info_bytes(&legacy, legacy_len))
    }

    /// Windows publishes by handle (`publish_file_by_handle`); the
    /// pathname-bound macOS promotion has no Windows arm.
    pub fn promote_exclusive(&self, _from: &[u8], _to: &[u8]) -> io::Result<bool> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }

    /// Class F/H: create-only publication of the object `file` holds under
    /// `to` in this directory — one handle-bound rename with
    /// `ReplaceIfExists = FALSE`. The staging NAME is never resolved, so a
    /// swap after verification cannot change what is published.
    pub fn publish_file_by_handle(&self, file: &File, to: &[u8]) -> io::Result<bool> {
        let wide = to_wide(to)?;
        rename_no_replace(file.as_raw_handle() as HANDLE, self.raw(), &wide)
    }

    pub fn publish_file_by_handle_spelled(
        &self,
        file: &File,
        to: &[u8],
        _preferred: Option<LinkByHandleSpelling>,
    ) -> io::Result<(bool, LinkByHandleSpelling)> {
        self.publish_file_by_handle(file, to)
            .map(|inserted| (inserted, LinkByHandleSpelling::EmptyPath))
    }

    /// Darwin-only copy-on-write clone publication; Windows publishes the
    /// staged object itself by handle.
    pub fn publish_open_file_clone_exclusive(
        &self,
        _source: &File,
        _to: &[u8],
    ) -> io::Result<bool> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }

    fn open_for_delete(&self, name: &[u8]) -> io::Result<OwnedHandle> {
        let wide = to_wide(name)?;
        nt_create_relative(
            self.raw(),
            &wide,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            0,
            SHARE_ALL,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        )
    }

    /// Class L: removes a child that is NOT a directory (mirrors `unlinkat`
    /// without `AT_REMOVEDIR`). A link object is removed as itself.
    pub fn unlink_child(&self, name: &[u8]) -> io::Result<()> {
        let handle = self.open_for_delete(name)?;
        if kind_of(handle.as_raw_handle() as HANDLE)? == EntryKind::Directory {
            return Err(not_a_directory());
        }
        delete_by_handle(handle.as_raw_handle() as HANDLE)
    }

    /// Class L, identity-checked.
    pub fn unlink_child_if_identity(&self, name: &[u8], owned: ObjectIdentity) -> io::Result<bool> {
        let handle = match self.open_for_delete(name) {
            Ok(handle) => handle,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(err) => return Err(err),
        };
        let raw = handle.as_raw_handle() as HANDLE;
        if kind_of(raw)? == EntryKind::Directory || identity_of(raw)? != owned {
            return Ok(false);
        }
        delete_by_handle(raw)?;
        Ok(true)
    }

    /// Class L: removes an EMPTY child directory (mirrors `AT_REMOVEDIR`).
    pub fn unlink_child_dir(&self, name: &[u8]) -> io::Result<()> {
        let handle = self.open_for_delete(name)?;
        if kind_of(handle.as_raw_handle() as HANDLE)? != EntryKind::Directory {
            return Err(not_a_directory());
        }
        delete_by_handle(handle.as_raw_handle() as HANDLE)
    }

    /// Class L, identity-checked, for an EMPTY directory this operation created.
    pub fn unlink_child_dir_if_identity(
        &self,
        name: &[u8],
        owned: ObjectIdentity,
    ) -> io::Result<bool> {
        let handle = match self.open_for_delete(name) {
            Ok(handle) => handle,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(err) => return Err(err),
        };
        let raw = handle.as_raw_handle() as HANDLE;
        if kind_of(raw)? != EntryKind::Directory || identity_of(raw)? != owned {
            return Ok(false);
        }
        delete_by_handle(raw)?;
        Ok(true)
    }

    /// Identity of this directory object.
    pub fn identity(&self) -> io::Result<ObjectIdentity> {
        identity_of(self.raw())
    }

    /// Enumerates entry names from THIS handle (`FileIdBothDirectoryInfo`),
    /// returned as UTF-8 bytes.
    pub fn read_entry_names(&self) -> io::Result<Vec<Vec<u8>>> {
        let mut names = Vec::new();
        // 8-byte aligned: the kernel writes pointer-aligned records.
        let mut buf = vec![0u64; (64 * 1024) / 8];
        let buf_len = buf.len() * 8;
        let mut class = FileIdBothDirectoryRestartInfo;
        loop {
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    self.raw(),
                    class,
                    buf.as_mut_ptr() as *mut core::ffi::c_void,
                    buf_len as u32,
                )
            };
            if ok == 0 {
                let err = last_err();
                if err.raw_os_error().map(|c| c as u32) == Some(ERROR_NO_MORE_FILES) {
                    break;
                }
                return Err(err);
            }
            class = FileIdBothDirectoryInfo;
            let base = buf.as_ptr() as *const u8;
            let mut offset = 0usize;
            loop {
                if offset + std::mem::size_of::<FILE_ID_BOTH_DIR_INFO>() > buf_len {
                    break;
                }
                // SAFETY: the kernel filled a chain of FILE_ID_BOTH_DIR_INFO
                // records inside `buf`; every field is read unaligned through
                // raw pointers and the name length is bounded by the buffer.
                let record = unsafe { base.add(offset) as *const FILE_ID_BOTH_DIR_INFO };
                let next =
                    unsafe { std::ptr::addr_of!((*record).NextEntryOffset).read_unaligned() };
                let name_bytes =
                    unsafe { std::ptr::addr_of!((*record).FileNameLength).read_unaligned() }
                        as usize;
                let name_ptr = unsafe { std::ptr::addr_of!((*record).FileName) as *const u16 };
                let name_offset = name_ptr as usize - base as usize;
                if name_offset + name_bytes > buf_len {
                    break;
                }
                let mut units = vec![0u16; name_bytes / 2];
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        name_ptr as *const u8,
                        units.as_mut_ptr() as *mut u8,
                        name_bytes,
                    );
                }
                let name = String::from_utf16_lossy(&units);
                if name != "." && name != ".." {
                    names.push(name.into_bytes());
                }
                if next == 0 {
                    break;
                }
                offset += next as usize;
            }
        }
        Ok(names)
    }

    fn volume_information(&self) -> io::Result<(u32, u32, u32, Vec<u16>)> {
        let mut serial = 0u32;
        let mut max_component = 0u32;
        let mut flags = 0u32;
        let mut fs_name = vec![0u16; 64];
        let ok = unsafe {
            GetVolumeInformationByHandleW(
                self.raw(),
                std::ptr::null_mut(),
                0,
                &mut serial,
                &mut max_component,
                &mut flags,
                fs_name.as_mut_ptr(),
                fs_name.len() as u32,
            )
        };
        if ok == 0 {
            return Err(last_err());
        }
        Ok((serial, max_component, flags, fs_name))
    }

    /// Maximum component length of this directory's volume
    /// (`lpMaximumComponentLength`, 255 UTF-16 units on NTFS). ASCII-only
    /// governed names make bytes = units. Fails closed when unanswerable.
    pub fn name_max(&self) -> io::Result<u64> {
        let (_, max_component, _, _) = self.volume_information()?;
        if max_component == 0 {
            return Err(io::Error::from(io::ErrorKind::Unsupported));
        }
        Ok(max_component as u64)
    }

    /// Available bytes on the volume holding this directory. Resolved through
    /// the handle's final path (a read-only query; no governed mutation ever
    /// uses that path). `None` when unanswerable — callers fail closed.
    pub fn available_bytes(&self) -> Option<u64> {
        let mut path = vec![0u16; 1024];
        let len = unsafe {
            GetFinalPathNameByHandleW(
                self.raw(),
                path.as_mut_ptr(),
                path.len() as u32,
                VOLUME_NAME_DOS,
            )
        };
        if len == 0 || len as usize >= path.len() {
            return None;
        }
        path.truncate(len as usize);
        path.push(0);
        let mut available = 0u64;
        let mut total = 0u64;
        let mut free = 0u64;
        let ok =
            unsafe { GetDiskFreeSpaceExW(path.as_ptr(), &mut available, &mut total, &mut free) };
        if ok == 0 {
            return None;
        }
        Some(available)
    }

    /// Class G: create-only directory publication — the same handle-bound
    /// no-replace rename on the STAGING DIRECTORY handle the caller retains,
    /// with this directory as `RootDirectory`. Own member handles must be
    /// closed before the call; a foreign open handle inside the tree yields a
    /// retryable refusal, never a partial final name.
    pub fn promote_dir_exclusive(
        &self,
        staging: &Dir,
        _from: &[u8],
        to: &[u8],
    ) -> io::Result<bool> {
        let wide = to_wide(to)?;
        rename_no_replace(staging.raw(), self.raw(), &wide)
    }

    /// Class M: one no-replace move of `name` from this directory into `dest`
    /// as `item`: the source entry is opened relative (reparse refused,
    /// `DELETE` access) and renamed by that handle with `dest` as
    /// `RootDirectory`. `Ok(false)` on collision; a cross-volume target
    /// surfaces as `STATUS_NOT_SAME_DEVICE`, classified capability-absent.
    pub fn move_exclusive_into(&self, name: &[u8], dest: &Dir, item: &[u8]) -> io::Result<bool> {
        let source = self.open_for_delete(name)?;
        let raw = source.as_raw_handle() as HANDLE;
        if kind_of(raw)? == EntryKind::Symlink {
            return Err(reparse_refusal());
        }
        let wide = to_wide(item)?;
        rename_no_replace(raw, dest.raw(), &wide)
    }

    /// Class K: the normal flush on the parent directory handle after a
    /// namespace change. Acceptance on a directory handle is PROVEN by the
    /// class O probe (`CAP-DIRFLUSH`) before any publication relies on it.
    pub fn sync(&self) -> io::Result<()> {
        flush(self.raw())
    }

    /// Class N open: the presence lock file, opened relative to this admitted
    /// root (`FILE_OPEN_IF`, reparse refused) with `FILE_SHARE_READ |
    /// FILE_SHARE_WRITE` and deliberately WITHOUT `FILE_SHARE_DELETE`, so the
    /// file cannot be removed while any instance holds it.
    pub fn open_lock_file(&self, name: &[u8]) -> io::Result<File> {
        let wide = to_wide(name)?;
        let handle = nt_create_relative(
            self.raw(),
            &wide,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE,
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_OPEN_IF,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        )?;
        match kind_of(handle.as_raw_handle() as HANDLE)? {
            EntryKind::Regular | EntryKind::Other => Ok(File::from(handle)),
            EntryKind::Symlink => Err(reparse_refusal()),
            EntryKind::Directory => Err(not_a_directory()),
        }
    }

    /// Class O evidence: the filesystem name the volume reports. Windows
    /// declares no rename-excl / clone capability; every capability is proven
    /// behaviourally by the probe.
    pub fn declared_volume_capabilities(&self) -> DeclaredVolumeCapabilities {
        let mut out = DeclaredVolumeCapabilities::default();
        if let Ok((_, _, _, fs_name)) = self.volume_information() {
            let end = fs_name
                .iter()
                .position(|u| *u == 0)
                .unwrap_or(fs_name.len());
            let text = String::from_utf16_lossy(&fs_name[..end]);
            let bytes = text.as_bytes();
            let len = bytes.len().min(16);
            let mut name = [0u8; 16];
            name[..len].copy_from_slice(&bytes[..len]);
            out.filesystem_name = Some(name);
            out.filesystem_name_len = len;
        }
        out
    }
}

// `CloseHandle` is what `OwnedHandle`'s Drop calls; referenced explicitly so
// the import documents the ownership model rather than being dead.
#[allow(dead_code)]
fn _close(handle: HANDLE) {
    unsafe {
        CloseHandle(handle);
    }
}
