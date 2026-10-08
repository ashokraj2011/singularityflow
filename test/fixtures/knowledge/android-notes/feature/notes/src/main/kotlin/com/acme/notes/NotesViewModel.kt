package com.acme.notes

import androidx.lifecycle.ViewModel
import com.acme.data.NoteEntity
import com.acme.data.NotesRepository

const val MAX_TITLE_LENGTH = 200

class NotesViewModel(private val repository: NotesRepository) : ViewModel() {
    var error: String? = null
        private set

    fun save(title: String, body: String) {
        if (title.isBlank()) {
            error = "Title is required"
            return
        }
        if (title.length > MAX_TITLE_LENGTH) {
            error = "Title is too long"
            return
        }
        repository.save(NoteEntity(id = 0, title = title, body = body))
    }

    fun delete(note: NoteEntity, ownerId: Long) {
        if (note.ownerId != ownerId) {
            throw IllegalStateException("Only the owner can delete a note")
        }
        repository.delete(note)
    }
}
